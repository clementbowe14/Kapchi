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

function createPool(failure?: { tag: string; error: Error }) {
  const release = vi.fn();
  const databaseQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (failure && sql.includes(failure.tag)) {
      throw failure.error;
    }
    if (sql.includes("sales_analytics:bounds")) {
      return {
        rows: [{
          end_exclusive: new Date("2026-09-03T00:00:00.000Z"),
          start_inclusive: new Date("2026-09-01T00:00:00.000Z")
        }]
      };
    }
    if (sql.includes("sales_analytics:summary")) {
      return {
        rows: [{
          average_order_value_minor: "1200",
          discount_minor: "100",
          gross_sales_minor: "2500",
          net_sales_minor: "300",
          paid_order_count: "2",
          successful_refunds_minor: "2100",
          units_sold: "3"
        }]
      };
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
  it("builds one repeatable-read report with ledger refunds and signed net sales", async () => {
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
      endExclusive: "2026-09-03T00:00:00.000Z",
      startInclusive: "2026-09-01T00:00:00.000Z"
    });
    expect(databaseQuery.mock.calls[0]?.[0]).toBe(
      "begin transaction isolation level repeatable read read only",
    );
    expect(databaseQuery.mock.calls.at(-1)?.[0]).toBe("commit");

    const summary = databaseQuery.mock.calls.find(([sql]) =>
      String(sql).includes("sales_analytics:summary"),
    );
    expect(summary?.[1]).toEqual([
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-03T00:00:00.000Z"),
      "usd",
      ["paid", "partially_refunded", "refunded"]
    ]);
    expect(String(summary?.[0])).toContain("oi.currency = o.currency");
    const buckets = databaseQuery.mock.calls.find(([sql]) =>
      sql.includes("sales_analytics:time_buckets"),
    );
    expect(buckets?.[1]).toEqual([...summary![1]!, query.timezone, query.bucket]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      tag: "sales_analytics:summary",
      error: Object.assign(new Error('relation "refund_operations" does not exist'), { code: "42P01" })
    },
    { tag: "sales_analytics:best_sellers", error: new Error("private database detail") }
  ])("rolls back and releases the connection when $tag fails", async (failure) => {
    const { databaseQuery, pool, release } = createPool(failure);

    await expect(
      new SalesAnalyticsRepository(pool).getSalesReport(query),
    ).rejects.toBe(failure.error);

    expect(databaseQuery.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(databaseQuery.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
