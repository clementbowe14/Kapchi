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
  items: { quantity: number; unitAmountMinor: number }[];
  paymentStatus: string;
  productLabel?: string;
  shippingMinor?: number;
  status: string;
  taxMinor?: number;
};

integrationDescribe("SalesAnalyticsRepository database", () => {
  const orderIds: string[] = [];
  const userIds: string[] = [];
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  afterEach(async () => {
    if (orderIds.length > 0) {
      await pool.query("delete from refund_operations where order_id = any($1::uuid[])", [orderIds]);
      await pool.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    if (userIds.length > 0) {
      await pool.query("delete from users where id = any($1::uuid[])", [userIds]);
    }
    orderIds.length = 0;
    userIds.length = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertOrder(testOrder: TestOrder) {
    const orderId = randomUUID();
    const grossMinor = testOrder.items.reduce(
      (total, item) => total + item.quantity * item.unitAmountMinor,
      0,
    );
    const shippingMinor = testOrder.shippingMinor ?? 0;
    const taxMinor = testOrder.taxMinor ?? 0;
    orderIds.push(orderId);
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          subtotal_cents, discount_cents, total_cents, currency, paid_at, created_at,
          shipping_cents, tax_cents, stripe_payment_intent_id
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          case when $4::payment_status = 'unpaid' then null else $10::timestamptz end,
          $10::timestamptz, $11, $12, $13
        )
      `,
      [
        orderId,
        `ANALYTICS-${orderId}`,
        testOrder.status,
        testOrder.paymentStatus,
        testOrder.fulfillmentStatus,
        grossMinor,
        testOrder.discountMinor,
        grossMinor + shippingMinor + taxMinor - testOrder.discountMinor,
        testOrder.currency,
        testOrder.createdAt,
        shippingMinor,
        taxMinor,
        `pi_analytics_${orderId}`
      ],
    );
    for (const { quantity, unitAmountMinor } of testOrder.items) {
      await pool.query(
        `
          insert into order_items (
            order_id, quantity, unit_amount_cents, total_amount_cents, currency,
            stripe_product_id, listing_snapshot, customization_snapshot
          ) values (
            $1, $2, $3, $4, $5, 'prod_analytics_archived', $6::jsonb, '{}'::jsonb
          )
        `,
        [
          orderId,
          quantity,
          unitAmountMinor,
          quantity * unitAmountMinor,
          testOrder.currency,
          JSON.stringify({
            slug: "archived-stole",
            title: testOrder.productLabel ?? "Archived Stole"
          })
        ],
      );
    }
    return orderId;
  }

  async function insertRefund(
    orderId: string,
    {
      actorId,
      amountMinor,
      currency = "tst",
      occurredAt = "2026-09-03T18:00:00.000Z",
      status = "succeeded"
    }: {
      actorId?: string;
      amountMinor: number;
      currency?: string;
      occurredAt?: string;
      status?: "succeeded" | "pending" | "failed";
    },
  ) {
    const id = randomUUID();
    await pool.query(
      `
        insert into refund_operations (
          order_id, payment_intent_id, provider_account_id, livemode, amount_cents,
          currency, reason_code, actor_user_id, actor_auth_subject, origin, status,
          pending_reason, provider_refund_id, client_idempotency_key,
          provider_idempotency_key, request_fingerprint, created_at,
          provider_created_at, succeeded_at, failed_at
        ) values (
          $1, $2, 'acct_analytics_test', false, $3, $4, 'other', $5, $6, $7, $8,
          case when $8::refund_status = 'pending' then 'provider_pending'::refund_pending_reason end,
          $9, $10, $11, $12, $13, $13,
          case when $8::refund_status = 'succeeded' then $13::timestamptz end,
          case when $8::refund_status = 'failed' then $13::timestamptz end
        )
      `,
      [
        orderId,
        `pi_analytics_${orderId}`,
        amountMinor,
        currency,
        actorId ?? null,
        actorId ? `analytics-${actorId}` : null,
        actorId ? "kapchi" : "stripe_external",
        status,
        `re_analytics_${id}`,
        `analytics:client:${id}`,
        `analytics:provider:${id}`,
        id,
        occurredAt
      ],
    );
  }

  it("reconciles refund and sales totals without item fanout or currency and cohort leakage", async () => {
    const firstOrderId = await insertOrder({
      createdAt: "2026-09-01T00:00:00.000Z",
      currency: "tst",
      discountMinor: 100,
      fulfillmentStatus: "cancelled",
      items: [
        { quantity: 1, unitAmountMinor: 800 },
        { quantity: 1, unitAmountMinor: 1200 }
      ],
      paymentStatus: "refunded",
      productLabel: "Original Stole Title",
      shippingMinor: 200,
      status: "refunded",
      taxMinor: 50
    });
    await insertOrder({
      createdAt: "2026-09-02T23:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "cancelled",
      items: [{ quantity: 1, unitAmountMinor: 500 }],
      paymentStatus: "refunded",
      status: "refunded"
    });
    const partialOrderId = await insertOrder({
      createdAt: "2026-09-03T12:00:00.000Z",
      currency: "tst",
      discountMinor: 50,
      fulfillmentStatus: "queued",
      items: [{ quantity: 1, unitAmountMinor: 1000 }],
      paymentStatus: "partially_refunded",
      status: "paid"
    });
    const unpaidOrderId = await insertOrder({
      createdAt: "2026-09-01T12:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "not_started",
      items: [{ quantity: 1, unitAmountMinor: 700 }],
      paymentStatus: "unpaid",
      status: "pending_payment"
    });
    const otherCurrencyOrderId = await insertOrder({
      createdAt: "2026-09-01T12:00:00.000Z",
      currency: "oth",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      items: [{ quantity: 9, unitAmountMinor: 1100 }],
      paymentStatus: "paid",
      status: "paid"
    });
    const outOfRangeOrderId = await insertOrder({
      createdAt: "2026-09-04T00:00:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      items: [{ quantity: 8, unitAmountMinor: 1100 }],
      paymentStatus: "paid",
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
    const actorId = randomUUID();
    userIds.push(actorId);
    await pool.query(
      "insert into users (id, auth_provider, auth_subject) values ($1, 'clerk', $2)",
      [actorId, `analytics-${actorId}`],
    );
    await insertRefund(firstOrderId, { actorId, amountMinor: 700 });
    await insertRefund(firstOrderId, {
      amountMinor: 1450,
      occurredAt: "2026-09-05T12:00:00.000Z"
    });
    await insertRefund(firstOrderId, { amountMinor: 75, status: "pending" });
    await insertRefund(firstOrderId, { amountMinor: 80, status: "failed" });
    await insertRefund(firstOrderId, { amountMinor: 90, currency: "oth" });
    await insertRefund(partialOrderId, { amountMinor: 200 });
    await insertRefund(unpaidOrderId, { amountMinor: 95 });
    await insertRefund(otherCurrencyOrderId, { amountMinor: 105, currency: "oth" });
    await insertRefund(outOfRangeOrderId, {
      amountMinor: 110,
      occurredAt: "2026-09-04T12:00:00.000Z"
    });

    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "tst",
      endDate: "2026-09-03",
      startDate: "2026-09-01",
      timezone: "UTC"
    });

    expect(report.cohort).toMatchObject({
      endExclusive: "2026-09-04T00:00:00.000Z",
      startInclusive: "2026-09-01T00:00:00.000Z"
    });
    expect(report.metrics).toEqual({
      averageOrderValueMinor: 1117,
      discountMinor: 150,
      grossSalesMinor: 3500,
      netSalesMinor: 1000,
      paidOrderCount: 3,
      successfulRefundsMinor: 2350,
      unitsSold: 4
    });
    expect(report.paymentBreakdown).toEqual([
      { count: 1, status: "unpaid" },
      { count: 2, status: "refunded" },
      { count: 1, status: "partially_refunded" }
    ]);
    expect(report.fulfillmentBreakdown).toEqual([
      { count: 1, status: "not_started" },
      { count: 1, status: "queued" },
      { count: 2, status: "cancelled" }
    ]);
    expect(report.bestSellers).toEqual([{
      grossSalesMinor: 3500,
      label: "Archived Stole",
      productKey: "archived-stole",
      unitsSold: 4
    }]);
    expect(report.timeBuckets).toEqual([
      {
        discountMinor: 100,
        endExclusive: "2026-09-02T00:00:00.000Z",
        grossSalesMinor: 2000,
        netSalesMinor: -250,
        paidOrderCount: 1,
        startInclusive: "2026-09-01T00:00:00.000Z",
        successfulRefundsMinor: 2150,
        unitsSold: 2
      },
      {
        discountMinor: 0,
        endExclusive: "2026-09-03T00:00:00.000Z",
        grossSalesMinor: 500,
        netSalesMinor: 500,
        paidOrderCount: 1,
        startInclusive: "2026-09-02T00:00:00.000Z",
        successfulRefundsMinor: 0,
        unitsSold: 1
      },
      {
        discountMinor: 50,
        endExclusive: "2026-09-04T00:00:00.000Z",
        grossSalesMinor: 1000,
        netSalesMinor: 750,
        paidOrderCount: 1,
        startInclusive: "2026-09-03T00:00:00.000Z",
        successfulRefundsMinor: 200,
        unitsSold: 1
      }
    ]);
    for (const field of ["successfulRefundsMinor", "netSalesMinor"] as const) {
      expect(report.timeBuckets.reduce((total, bucket) => total + bucket[field], 0))
        .toBe(report.metrics[field]);
    }
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
      netSalesMinor: 0,
      paidOrderCount: 0,
      successfulRefundsMinor: 0,
      unitsSold: 0
    });
    expect(report.timeBuckets).toMatchObject([
      { grossSalesMinor: 0, netSalesMinor: 0, successfulRefundsMinor: 0 },
      { grossSalesMinor: 0, netSalesMinor: 0, successfulRefundsMinor: 0 }
    ]);
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

  it("keeps the first occurrence of Azores midnight in the first bucket", async () => {
    const orderId = await insertOrder({
      createdAt: "2026-10-25T00:30:00.000Z",
      currency: "tst",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      items: [{ quantity: 1, unitAmountMinor: 1000 }],
      paymentStatus: "paid",
      status: "paid"
    });
    await insertRefund(orderId, {
      amountMinor: 200,
      occurredAt: "2026-10-26T12:00:00.000Z"
    });

    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "tst",
      endDate: "2026-10-26",
      startDate: "2026-10-25",
      timezone: "Atlantic/Azores"
    });

    expect(report.metrics).toMatchObject({
      grossSalesMinor: 1000,
      netSalesMinor: 800,
      paidOrderCount: 1,
      successfulRefundsMinor: 200
    });
    expect(report.timeBuckets).toMatchObject([
      {
        endExclusive: "2026-10-26T01:00:00.000Z",
        grossSalesMinor: 1000,
        netSalesMinor: 800,
        paidOrderCount: 1,
        startInclusive: "2026-10-25T00:00:00.000Z",
        successfulRefundsMinor: 200
      },
      {
        endExclusive: "2026-10-27T00:00:00.000Z",
        grossSalesMinor: 0,
        netSalesMinor: 0,
        paidOrderCount: 0,
        startInclusive: "2026-10-26T01:00:00.000Z",
        successfulRefundsMinor: 0
      }
    ]);
  });
});
