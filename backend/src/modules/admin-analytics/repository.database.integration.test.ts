import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { SalesAnalyticsRepository } from "./repository.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type TestOrder = {
  createdAt: string;
  currency: string;
  discountMinor: number;
  fulfillmentStatus: string;
  grossMinor: number;
  paymentStatus: string;
  productLabel?: string;
  quantity: number;
  status: string;
};

integrationDescribe("SalesAnalyticsRepository database", () => {
  let orderIds: string[] = [];
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  afterEach(async () => {
    if (orderIds.length > 0) {
      await pool.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    orderIds = [];
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertOrder(testOrder: TestOrder) {
    const orderId = randomUUID();
    orderIds.push(orderId);
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          subtotal_cents, discount_cents, total_cents, currency, paid_at, created_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          case when $4::payment_status = 'unpaid' then null else $10::timestamptz end,
          $10::timestamptz
        )
      `,
      [
        orderId,
        `ANALYTICS-${orderId}`,
        testOrder.status,
        testOrder.paymentStatus,
        testOrder.fulfillmentStatus,
        testOrder.grossMinor,
        testOrder.discountMinor,
        testOrder.grossMinor - testOrder.discountMinor,
        testOrder.currency,
        testOrder.createdAt
      ],
    );
    await pool.query(
      `
        insert into order_items (
          order_id, quantity, unit_amount_cents, total_amount_cents, currency,
          stripe_product_id, listing_snapshot, customization_snapshot
        ) values (
          $1, $2, $3, $4, $5, 'prod_analytics_archived',
          $6::jsonb,
          '{}'::jsonb
        )
      `,
      [
        orderId,
        testOrder.quantity,
        testOrder.grossMinor / testOrder.quantity,
        testOrder.grossMinor,
        testOrder.currency,
        JSON.stringify({
          slug: "archived-stole",
          title: testOrder.productLabel ?? "Archived Stole"
        })
      ],
    );
    return orderId;
  }

  it("reconciles metrics and buckets without crossing currency or date boundaries", async () => {
    const firstOrderId = await insertOrder({
      createdAt: "2026-09-01T00:00:00.000Z",
      currency: "tst",
      discountMinor: 100,
      fulfillmentStatus: "queued",
      grossMinor: 2000,
      paymentStatus: "paid",
      productLabel: "Original Stole Title",
      quantity: 2,
      status: "paid"
    });
    await insertOrder({
      createdAt: "2026-09-02T23:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "cancelled",
      grossMinor: 500,
      paymentStatus: "refunded",
      quantity: 1,
      status: "refunded"
    });
    await insertOrder({
      createdAt: "2026-09-01T12:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "not_started",
      grossMinor: 700,
      paymentStatus: "unpaid",
      quantity: 1,
      status: "pending_payment"
    });
    await insertOrder({
      createdAt: "2026-09-01T12:00:00.000Z",
      currency: "oth",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      grossMinor: 9900,
      paymentStatus: "paid",
      quantity: 9,
      status: "paid"
    });
    await insertOrder({
      createdAt: "2026-09-03T00:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      grossMinor: 8800,
      paymentStatus: "paid",
      quantity: 8,
      status: "paid"
    });
    await pool.query(
      `
        insert into order_items (
          order_id, quantity, unit_amount_cents, total_amount_cents, currency,
          listing_snapshot, customization_snapshot
        ) values (
          $1, 10, 999, 9990, 'oth',
          '{"slug":"wrong-currency","title":"Wrong Currency"}'::jsonb,
          '{}'::jsonb
        )
      `,
      [firstOrderId],
    );

    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "tst",
      endDate: "2026-09-02",
      startDate: "2026-09-01",
      timezone: "UTC"
    });

    expect(report.cohort).toMatchObject({
      endExclusive: "2026-09-03T00:00:00.000Z",
      startInclusive: "2026-09-01T00:00:00.000Z"
    });
    expect(report.metrics).toEqual({
      averageOrderValueMinor: 1200,
      discountMinor: 100,
      grossSalesMinor: 2500,
      netSalesMinor: null,
      paidOrderCount: 2,
      successfulRefundsMinor: null,
      unitsSold: 3
    });
    expect(report.paymentBreakdown).toEqual([
      { count: 1, status: "unpaid" },
      { count: 1, status: "paid" },
      { count: 1, status: "refunded" }
    ]);
    expect(report.fulfillmentBreakdown).toEqual([
      { count: 1, status: "not_started" },
      { count: 1, status: "queued" },
      { count: 1, status: "cancelled" }
    ]);
    expect(report.bestSellers).toEqual([{
      grossSalesMinor: 2500,
      label: "Archived Stole",
      productKey: "archived-stole",
      unitsSold: 3
    }]);
    expect(report.timeBuckets).toEqual([
      {
        discountMinor: 100,
        endExclusive: "2026-09-02T00:00:00.000Z",
        grossSalesMinor: 2000,
        netSalesMinor: null,
        paidOrderCount: 1,
        startInclusive: "2026-09-01T00:00:00.000Z",
        successfulRefundsMinor: null,
        unitsSold: 2
      },
      {
        discountMinor: 0,
        endExclusive: "2026-09-03T00:00:00.000Z",
        grossSalesMinor: 500,
        netSalesMinor: null,
        paidOrderCount: 1,
        startInclusive: "2026-09-02T00:00:00.000Z",
        successfulRefundsMinor: null,
        unitsSold: 1
      }
    ]);
  });

  it("returns continuous zero buckets for an empty period", async () => {
    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "zzz",
      endDate: "2026-02-02",
      startDate: "2026-02-01",
      timezone: "UTC"
    });

    expect(report.metrics).toEqual({
      averageOrderValueMinor: 0,
      discountMinor: 0,
      grossSalesMinor: 0,
      netSalesMinor: null,
      paidOrderCount: 0,
      successfulRefundsMinor: null,
      unitsSold: 0
    });
    expect(report.timeBuckets).toHaveLength(2);
    expect(report.timeBuckets.every((bucket) => bucket.grossSalesMinor === 0)).toBe(
      true,
    );
  });

  it("keeps local calendar-day buckets nonoverlapping across daylight saving time", async () => {
    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "zzz",
      endDate: "2026-11-02",
      startDate: "2026-10-31",
      timezone: "America/New_York"
    });

    expect(report.timeBuckets.map((bucket) => [
      bucket.startInclusive,
      bucket.endExclusive
    ])).toEqual([
      ["2026-10-31T00:00:00.000Z", "2026-10-31T04:00:00.000Z"],
      ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"],
      ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
      ["2026-11-02T05:00:00.000Z", "2026-11-03T00:00:00.000Z"]
    ]);
  });
});
