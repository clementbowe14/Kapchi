import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { refundRequestFingerprint } from "./fingerprint.js";
import { RefundRepository } from "./repository.js";
import type { ProviderPaymentSnapshot, RefundActor, RefundRequest } from "./types.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("RefundRepository database invariants", () => {
  let pool: Pool;
  let repository: RefundRepository;
  const orderIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new RefundRepository(pool);
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

  async function fixture(capturedAmountCents = 5000) {
    const orderId = randomUUID();
    const userId = randomUUID();
    const paymentIntentId = `pi_integration_${randomUUID()}`;
    orderIds.push(orderId);
    userIds.push(userId);
    await pool.query(
      `insert into users (id, auth_provider, auth_subject) values ($1, 'clerk', $2)`,
      [userId, `integration-${userId}`],
    );
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          subtotal_cents, total_cents, currency, stripe_payment_intent_id, paid_at
        ) values ($1, $2, 'paid', 'paid', 'queued', $3, $3, 'usd', $4, now())
      `,
      [orderId, `REFUND-${orderId}`, capturedAmountCents, paymentIntentId],
    );
    const snapshot: ProviderPaymentSnapshot = {
      apiVersion: "2026-02-25.clover",
      capturedAmountCents,
      currency: "usd",
      latestChargeId: `ch_${randomUUID()}`,
      livemode: false,
      paymentIntentId,
      providerAccountId: "acct_integration",
      providerPaymentStatus: "succeeded",
      refunds: []
    };
    await repository.applyReconciliation(orderId, snapshot);
    return {
      actor: { authSubject: `integration-${userId}`, userId } satisfies RefundActor,
      orderId,
      snapshot
    };
  }

  const request: RefundRequest = {
    amountCents: 4000,
    currency: "usd",
    notificationRequested: false,
    reasonCode: "other",
    restockRequested: false
  };

  it("serializes simultaneous reservations so they cannot over-reserve", async () => {
    const { actor, orderId } = await fixture();
    const attempts = ["concurrent-a", "concurrent-b"].map((key) =>
      repository.reserve(
        orderId,
        actor,
        request,
        key,
        refundRequestFingerprint(orderId, actor, request),
      ),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await repository.summary(orderId)).toMatchObject({
      pendingAmountCents: 4000,
      remainingRefundableAmountCents: 1000
    });
  });

  it("claims an empty recovery queue without ambiguous SQL columns", async () => {
    expect(await repository.claimRecoveryCandidates(10, randomUUID())).toEqual([]);
  });

  it("imports provider truth and fails an unattempted conflicting reservation", async () => {
    const { actor, orderId, snapshot } = await fixture();
    const fullRequest = { ...request, amountCents: 5000 };
    await repository.reserve(
      orderId,
      actor,
      fullRequest,
      "external-conflict",
      refundRequestFingerprint(orderId, actor, fullRequest),
    );
    await repository.applyReconciliation(orderId, {
      ...snapshot,
      refunds: [{
        amountCents: 5000,
        chargeId: snapshot.latestChargeId,
        createdAt: new Date(),
        currency: "usd",
        failureCode: null,
        id: `re_external_${randomUUID()}`,
        livemode: false,
        metadata: {},
        paymentIntentId: snapshot.paymentIntentId,
        status: "succeeded"
      }]
    });
    const summary = await repository.summary(orderId);
    expect(summary).toMatchObject({
      pendingAmountCents: 0,
      reconciliationStatus: "current",
      remainingRefundableAmountCents: 0,
      succeededAmountCents: 5000
    });
    expect(summary.operations.some((entry) => entry.failureCode === "balance_consumed_externally")).toBe(true);
  });
});
