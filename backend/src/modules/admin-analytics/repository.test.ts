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

function createPool(failureTag?: string) {
  const release = vi.fn();
  const databaseQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (failureTag && sql.includes(failureTag)) {
      throw new Error("private database detail");
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
          paid_order_count: "2",
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
          paid_order_count: "1",
          start_inclusive: new Date("2026-09-01T04:00:00.000Z"),
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
  it("builds one repeatable-read report without fabricating refunds", async () => {
    const { databaseQuery, pool, release } = createPool();
    const report = await new SalesAnalyticsRepository(pool).getSalesReport(query);

    expect(report.metrics).toEqual({
      averageOrderValueMinor: 1200,
      discountMinor: 100,
      grossSalesMinor: 2500,
      netSalesMinor: null,
      paidOrderCount: 2,
      successfulRefundsMinor: null,
      unitsSold: 3
    });
    expect(report.capabilities.refunds).toEqual({
      available: false,
      dependencyIssue: 103,
      reason: "REFUND_LEDGER_UNAVAILABLE"
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
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the connection when an aggregate fails", async () => {
    const { databaseQuery, pool, release } = createPool(
      "sales_analytics:best_sellers",
    );

    await expect(
      new SalesAnalyticsRepository(pool).getSalesReport(query),
    ).rejects.toThrow("private database detail");

    expect(
      databaseQuery.mock.calls.some(([sql]) => sql === "rollback"),
    ).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
