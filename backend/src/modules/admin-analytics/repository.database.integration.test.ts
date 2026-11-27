import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { AdminOrderRepository } from "../admin-orders/repository.js";
import type { AdminOrderSearchQuery } from "../admin-orders/types.js";
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

  function comparisonOrder(createdAt: string, overrides: Partial<TestOrder> = {}) {
    return insertOrder({
      createdAt,
      currency: "cmp",
      discountMinor: 0,
      fulfillmentStatus: "queued",
      items: [{ quantity: 1, unitAmountMinor: 100 }],
      paymentStatus: "paid",
      status: "paid",
      ...overrides
    });
  }

  async function walkPaidOrders(
    filters: Pick<AdminOrderSearchQuery, "createdFrom" | "createdTo" | "currency" | "lifecycle" | "paidOnly">,
    sort: AdminOrderSearchQuery["sort"],
  ) {
    const repository = new AdminOrderRepository(pool);
    const query = { ...filters, discountedOnly: false, refundedOnly: false, limit: 1, sort };
    const first = await repository.search(query);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.search({ ...query, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    return [...first.orders, ...second.orders].map(({ id }) => id);
  }

  it("compares contiguous leap-month periods and reconciles each paid drill-down across pages", async () => {
    const previousEarlier = await comparisonOrder("2024-02-29T12:00:00.123400Z");
    const previousLater = await comparisonOrder("2024-02-29T12:00:00.123456Z", {
      paymentStatus: "refunded", shippingMinor: 200, status: "refunded"
    });
    await insertRefund(previousLater, { amountMinor: 250, currency: "cmp" });
    const currentEarlier = await comparisonOrder("2024-03-01T00:00:00.000000Z");
    const currentLater = await comparisonOrder("2024-03-01T00:00:00.000456Z");
    await comparisonOrder("2024-02-29T09:00:00Z", { currency: "oth" });
    await comparisonOrder("2024-03-01T09:00:00Z", { currency: "oth" });
    const unpaid = { paymentStatus: "unpaid", status: "pending_payment" };
    await comparisonOrder("2024-02-29T09:00:00Z", unpaid);
    await comparisonOrder("2024-03-01T09:00:00Z", unpaid);
    await comparisonOrder("2024-02-26T23:59:59.999999Z");
    await comparisonOrder("2024-03-04T00:00:00Z");

    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "cmp",
      endDate: "2024-03-03",
      startDate: "2024-03-01",
      timezone: "America/New_York"
    });
    const { comparison, cohort } = report;
    const previous = comparison.previousPeriod;
    expect(previous).toMatchObject({
      startDateInclusive: "2024-02-27",
      endDateInclusive: "2024-02-29",
      startInclusive: "2024-02-27T00:00:00.000Z",
      endExclusive: cohort.startInclusive,
      metrics: { grossSalesMinor: 200, netSalesMinor: -50, paidOrderCount: 2, successfulRefundsMinor: 250 }
    });
    expect(report.metrics).toMatchObject({ grossSalesMinor: 200, netSalesMinor: 200, paidOrderCount: 2 });
    expect(comparison.hasBaseline).toBe(true);
    expect(comparison.percentChange).toEqual({
      averageOrderValueMinor: 0,
      discountMinor: null,
      grossSalesMinor: 0,
      netSalesMinor: 500,
      paidOrderCount: 0,
      successfulRefundsMinor: -100,
      unitsSold: 0
    });
    expect(await walkPaidOrders(cohort.drillDown, "created_asc")).toEqual([currentEarlier, currentLater]);
    expect(await walkPaidOrders(cohort.drillDown, "created_desc")).toEqual([currentLater, currentEarlier]);
    expect(await walkPaidOrders(previous.drillDown, "created_asc")).toEqual([previousEarlier, previousLater]);
    expect(await walkPaidOrders(previous.drillDown, "created_desc")).toEqual([previousLater, previousEarlier]);
  });

  it("keeps a very early UTC boundary exact and the derived dates usable in order search", async () => {
    const previousId = await comparisonOrder("0099-12-31T23:59:59.999999Z");
    const currentId = await comparisonOrder("0100-01-01T00:00:00Z");
    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10, bucket: "month", currency: "cmp", startDate: "0100-01-01",
      endDate: "0101-01-01", timezone: "UTC"
    });
    const previous = report.comparison.previousPeriod;
    expect(previous).toMatchObject({
      startDateInclusive: "0098-12-31",
      endDateInclusive: "0099-12-31",
      startInclusive: "0098-12-31T00:00:00.000Z",
      endExclusive: "0100-01-01T00:00:00.000Z",
      metrics: { paidOrderCount: 1 }
    });
    expect(report.metrics.paidOrderCount).toBe(1);
    const repository = new AdminOrderRepository(pool);
    const defaults = { discountedOnly: false, refundedOnly: false, limit: 25, sort: "created_desc" } as const;
    for (const [filters, expected] of [[previous.drillDown, previousId], [report.cohort.drillDown, currentId]] as const) {
      const page = await repository.search({ ...filters, ...defaults });
      expect(page.orders.map(({ id }) => id)).toEqual([expected]);
      expect(page.nextCursor).toBeNull();
    }
  });

  it("supports the last four-digit date without changing its public exclusive end", async () => {
    await comparisonOrder("9999-12-31T23:59:59.999999Z");
    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10, bucket: "day", currency: "cmp", startDate: "9999-12-31",
      endDate: "9999-12-31", timezone: "UTC"
    });
    expect(report.cohort.endExclusive).toBe("+010000-01-01T00:00:00.000Z");
    expect(report.metrics.paidOrderCount).toBe(1);
    expect(report.timeBuckets).toMatchObject([{ endExclusive: report.cohort.endExclusive, paidOrderCount: 1 }]);
    expect(report.comparison).toMatchObject({
      hasBaseline: false,
      previousPeriod: { startDateInclusive: "9999-12-30", endDateInclusive: "9999-12-30" }
    });
  });

  it("keeps the baseline in the same snapshot when a previous refund commits between reads", async () => {
    const orderId = await comparisonOrder("2026-01-01T00:00:00Z");
    let refundCommitted = false;
    const reportingPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("sales_analytics:summary") && !refundCommitted) {
              await insertRefund(orderId, { amountMinor: 40, currency: "cmp" });
              refundCommitted = true;
            }
            return result;
          },
          release: () => client.release()
        } as unknown as PoolClient;
      }
    };
    const query = {
      bestSellerLimit: 10, bucket: "day", currency: "cmp", startDate: "2026-01-02",
      endDate: "2026-01-02", timezone: "UTC"
    } as const;
    const inFlight = await new SalesAnalyticsRepository(reportingPool).getSalesReport(query);
    expect(refundCommitted).toBe(true);
    expect(inFlight.comparison.previousPeriod.metrics).toMatchObject({ netSalesMinor: 100, successfulRefundsMinor: 0 });
    expect(inFlight.comparison.percentChange.netSalesMinor).toBe(-100);
    const next = await new SalesAnalyticsRepository(pool).getSalesReport(query);
    expect(next.comparison.previousPeriod.metrics).toMatchObject({ netSalesMinor: 60, successfulRefundsMinor: 40 });
  });

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
    await comparisonOrder("2026-01-31T00:00:00Z", {
      currency: "zzz", paymentStatus: "unpaid", status: "pending_payment"
    });
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
    expect(report.comparison.hasBaseline).toBe(false);
    expect(report.comparison.previousPeriod.metrics).toEqual(report.metrics);
    expect(Object.values(report.comparison.percentChange)).toEqual(Array(7).fill(null));
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
