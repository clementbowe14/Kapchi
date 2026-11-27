import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { SalesAnalyticsRepository } from "./repository.js";
import type { SalesAnalyticsQuery } from "./types.js";

const query: SalesAnalyticsQuery = {
  bestSellerLimit: 5,
  bucket: "day",
  currency: "usd",
  endDate: "2026-09-02",
  startDate: "2026-09-01",
  timezone: "America/New_York"
};

const currentSummary = {
  average_order_value_minor: "1200",
  discount_minor: "100",
  gross_sales_minor: "2500",
  net_sales_minor: "300",
  paid_order_count: "2",
  successful_refunds_minor: "2100",
  units_sold: "3"
};

const previousSummary = {
  average_order_value_minor: "1500",
  discount_minor: "0",
  gross_sales_minor: "3000",
  net_sales_minor: "-1000",
  paid_order_count: "2",
  successful_refunds_minor: "4000",
  units_sold: "2"
};

const emptySummary = {
  average_order_value_minor: "0",
  discount_minor: "0",
  gross_sales_minor: "0",
  net_sales_minor: "0",
  paid_order_count: "0",
  successful_refunds_minor: "0",
  units_sold: "0"
};

function createPool({
  current = currentSummary,
  previous = previousSummary,
  failure
}: {
  current?: typeof currentSummary;
  previous?: typeof previousSummary;
  failure?: { tag: string; error: Error; startInclusive?: string };
} = {}) {
  const release = vi.fn();
  let summaryCalls = 0;
  const databaseQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (failure && sql.includes(failure.tag) &&
      (failure.startInclusive === undefined || failure.startInclusive === values?.[0])) {
      throw failure.error;
    }
    if (sql.includes("sales_analytics:bounds")) {
      const start = new Date(`${values?.[0]}T00:00:00.000Z`);
      const end = new Date(`${values?.[1]}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      return {
        rows: [{
          end_exclusive: end,
          start_inclusive: start
        }]
      };
    }
    if (sql.includes("sales_analytics:summary")) {
      return { rows: [summaryCalls++ === 0 ? current : previous] };
    }
    if (sql.includes("sales_analytics:payment_breakdown")) {
      return { rows: [{ order_count: "2", status: "paid" }] };
    }
    if (sql.includes("sales_analytics:fulfillment_breakdown")) {
      return { rows: [{ order_count: "2", status: "queued" }] };
    }
    if (sql.includes("sales_analytics:time_buckets")) {
      return {
        rows: [{
          discount_minor: "100",
          end_exclusive: new Date("2026-09-02T04:00:00.000Z"),
          gross_sales_minor: "2000",
          net_sales_minor: "-200",
          paid_order_count: "1",
          start_inclusive: new Date("2026-09-01T04:00:00.000Z"),
          successful_refunds_minor: "2100",
          units_sold: "2"
        }]
      };
    }
    if (sql.includes("sales_analytics:best_sellers")) {
      return {
        rows: [{
          gross_sales_minor: "2500",
          label: "Archived Stole",
          product_key: "archived-stole",
          units_sold: "3"
        }]
      };
    }
    return { rows: [] };
  });
  const client = { query: databaseQuery, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

  return { databaseQuery, pool, release };
}

describe("SalesAnalyticsRepository", () => {
  it("loads both summaries and only current details in one repeatable-read report", async () => {
    const { databaseQuery, pool, release } = createPool();
    const report = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(report.metrics).toEqual({
      averageOrderValueMinor: 1200,
      discountMinor: 100,
      grossSalesMinor: 2500,
      netSalesMinor: 300,
      paidOrderCount: 2,
      successfulRefundsMinor: 2100,
      unitsSold: 3
    });
    expect(report.timeBuckets[0]).toMatchObject({
      netSalesMinor: -200,
      successfulRefundsMinor: 2100
    });
    expect(report.capabilities.refunds).toEqual({ available: true });
    expect(report.metadata).toMatchObject({
      netSalesDefinition: "merchandise_less_discounts_less_unallocated_successful_payment_refunds",
      refundCohort: "associated_with_orders_in_created_at_cohort",
      refundCoverage: "recorded_ledger_only"
    });
    expect(report.bestSellers[0]).toMatchObject({
      label: "Archived Stole",
      unitsSold: 3
    });
    expect(report.cohort).toMatchObject({
      bucketTimezone: "America/New_York",
      currency: "usd",
      drillDown: {
        createdFrom: "2026-09-01",
        createdTo: "2026-09-02",
        currency: "usd",
        lifecycle: "all",
        paidOnly: true
      },
      endExclusive: "2026-09-03T00:00:00.000Z",
      startInclusive: "2026-09-01T00:00:00.000Z"
    });
    expect(report.comparison).toEqual({
      hasBaseline: true,
      previousPeriod: {
        drillDown: {
          createdFrom: "2026-08-30",
          createdTo: "2026-08-31",
          currency: "usd",
          lifecycle: "all",
          paidOnly: true
        },
        endDateInclusive: "2026-08-31",
        endExclusive: "2026-09-01T00:00:00.000Z",
        metrics: {
          averageOrderValueMinor: 1500,
          discountMinor: 0,
          grossSalesMinor: 3000,
          netSalesMinor: -1000,
          paidOrderCount: 2,
          successfulRefundsMinor: 4000,
          unitsSold: 2
        },
        startDateInclusive: "2026-08-30",
        startInclusive: "2026-08-30T00:00:00.000Z"
      },
      percentChange: {
        averageOrderValueMinor: -20,
        discountMinor: null,
        grossSalesMinor: expect.closeTo(-16.666666666666668, 12),
        netSalesMinor: 130,
        paidOrderCount: 0,
        successfulRefundsMinor: -47.5,
        unitsSold: 50
      }
    });

    const calls = databaseQuery.mock.calls.map(([sql, values]) => [
      /sales_analytics:(\w+)/.exec(sql)?.[1] ?? sql,
      values
    ]);
    const current = ["2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z", "usd"];
    const previous = ["2026-08-30T00:00:00.000Z", current[0], "usd"];
    const statuses = ["paid", "partially_refunded", "refunded"];
    expect(calls).toEqual([
      ["begin transaction isolation level repeatable read read only", undefined],
      ["bounds", [query.startDate, query.endDate]],
      ["summary", [...current, statuses]],
      ["summary", [...previous, statuses]],
      ["payment_breakdown", current],
      ["fulfillment_breakdown", current],
      ["time_buckets", [...current, statuses, query.timezone, query.bucket]],
      ["best_sellers", [...current, statuses, query.bestSellerLimit]],
      ["commit", undefined]
    ]);
    expect(databaseQuery.mock.calls[2]?.[0]).toContain("oi.currency = o.currency");
    expect(databaseQuery.mock.calls[3]?.[0]).toBe(databaseQuery.mock.calls[2]?.[0]);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns zero metrics and null changes when the baseline has no paid orders", async () => {
    const { pool } = createPool({ previous: emptySummary });
    const { comparison } = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(comparison.hasBaseline).toBe(false);
    expect(comparison.previousPeriod.metrics).toEqual({
      averageOrderValueMinor: 0,
      discountMinor: 0,
      grossSalesMinor: 0,
      netSalesMinor: 0,
      paidOrderCount: 0,
      successfulRefundsMinor: 0,
      unitsSold: 0
    });
    expect(comparison.percentChange).toEqual({
      averageOrderValueMinor: null,
      discountMinor: null,
      grossSalesMinor: null,
      netSalesMinor: null,
      paidOrderCount: null,
      successfulRefundsMinor: null,
      unitsSold: null
    });
  });

  it("keeps a paid zero-value baseline and returns null for zero-to-zero changes", async () => {
    const { pool } = createPool({
      current: { ...currentSummary, discount_minor: "0" },
      previous: { ...emptySummary, paid_order_count: "1" }
    });
    const { comparison } = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(comparison.hasBaseline).toBe(true);
    expect(comparison.percentChange.discountMinor).toBeNull();
    expect(comparison.percentChange.netSalesMinor).toBeNull();
    expect(comparison.percentChange.paidOrderCount).toBe(100);
  });

  it.each([
    { net: "-500", change: 50 },
    { net: "-1500", change: -50 }
  ])("uses the direction of change when net sales move from -1000 to $net", async ({ net, change }) => {
    const { pool } = createPool({ current: { ...currentSummary, net_sales_minor: net } });
    const { comparison } = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(comparison.percentChange.netSalesMinor).toBe(change);
  });

  it("compares an empty current period to a nonempty baseline", async () => {
    const { pool } = createPool({ current: emptySummary });
    const { comparison } = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(comparison.hasBaseline).toBe(true);
    expect(comparison.percentChange).toEqual({
      averageOrderValueMinor: -100,
      discountMinor: null,
      grossSalesMinor: -100,
      netSalesMinor: 100,
      paidOrderCount: -100,
      successfulRefundsMinor: -100,
      unitsSold: -100
    });
  });

  it.each([
    {
      startDate: "2024-03-01", endDate: "2024-03-03",
      previousStart: "2024-02-27", previousEnd: "2024-02-29"
    },
    {
      startDate: "0100-01-01", endDate: "0101-01-01",
      previousStart: "0098-12-31", previousEnd: "0099-12-31"
    }
  ])("derives the previous UTC cohort for $startDate through $endDate", async (dates) => {
    const { pool, databaseQuery } = createPool();
    const { cohort, comparison } = await new SalesAnalyticsRepository(pool).getSalesReport({
      ...query,
      startDate: dates.startDate,
      endDate: dates.endDate
    });

    expect(comparison.previousPeriod).toMatchObject({
      drillDown: { createdFrom: dates.previousStart, createdTo: dates.previousEnd },
      endDateInclusive: dates.previousEnd,
      endExclusive: cohort.startInclusive,
      startDateInclusive: dates.previousStart,
      startInclusive: `${dates.previousStart}T00:00:00.000Z`
    });
    expect(databaseQuery.mock.calls[3]?.[1]?.slice(0, 2)).toEqual([
      `${dates.previousStart}T00:00:00.000Z`, `${dates.startDate}T00:00:00.000Z`
    ]);
  });

  it("binds an unsigned year 10000 to PostgreSQL but retains the public ISO boundary", async () => {
    const { pool, databaseQuery } = createPool();
    const { cohort, comparison } = await new SalesAnalyticsRepository(pool).getSalesReport({
      ...query,
      startDate: "9999-12-31",
      endDate: "9999-12-31"
    });

    expect(cohort.endExclusive).toBe("+010000-01-01T00:00:00.000Z");
    expect(cohort.drillDown.createdTo).toBe("9999-12-31");
    expect(comparison.previousPeriod.startDateInclusive).toBe("9999-12-30");
    expect(comparison.previousPeriod.endExclusive).toBe("9999-12-31T00:00:00.000Z");
    const currentCalls = databaseQuery.mock.calls.filter(([, values]) =>
      values?.[0] === "9999-12-31T00:00:00.000Z",
    );
    expect(currentCalls).toHaveLength(5);
    for (const [, values] of currentCalls) {
      expect(values?.[1]).toBe("10000-01-01T00:00:00.000Z");
    }
  });

  it.each([
    {
      tag: "sales_analytics:summary",
      error: Object.assign(new Error('relation "refund_operations" does not exist'), { code: "42P01" })
    },
    {
      tag: "sales_analytics:summary",
      error: new Error("previous summary failed"),
      startInclusive: "2026-08-30T00:00:00.000Z"
    },
    { tag: "sales_analytics:best_sellers", error: new Error("private database detail") }
  ])("rolls back and releases the connection on $error.message", async (failure) => {
    const { databaseQuery, pool, release } = createPool({ failure });

    await expect(
      new SalesAnalyticsRepository(pool).getSalesReport(query),
    ).rejects.toBe(failure.error);

    expect(databaseQuery.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(databaseQuery.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
