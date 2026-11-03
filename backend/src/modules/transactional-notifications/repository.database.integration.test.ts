import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { ensureOrderConfirmationIntent } from "./producer.js";
import { renderNotification } from "./renderers.js";
import { TransactionalNotificationRepository } from "./repository.js";

loadBackendEnvironment();
const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("transactional notification storage", () => {
  let pool: Pool;
  let repository: TransactionalNotificationRepository;
  const orderId = randomUUID();

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new TransactionalNotificationRepository(
      pool,
      "https://shop.kapchi.test",
      "production",
    );
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status,
         customer_email, preferred_contact_method, paid_at,
         subtotal_cents, total_cents, currency
       ) values ($1, $2, 'paid', 'paid', 'queued', $3, 'email', now(), 4500, 4500, 'usd')`,
      [orderId, `NOTICE-${orderId}`, "original-recipient@example.test"],
    );
    await pool.query(
      `insert into order_items (
         order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, customization_snapshot
       ) values ($1, 1, 4500, 4500, 'usd',
                 '{"title":"Safe title","customization":"PRIVATE"}'::jsonb,
                 '{"text":"PRIVATE-CUSTOMIZATION"}'::jsonb)`,
      [orderId],
    );
  });

  afterAll(async () => {
    await pool?.query(
      `delete from transactional_notification_intents where order_id = $1`,
      [orderId],
    );
    await pool?.query("delete from orders where id = $1", [orderId]);
    await pool?.end();
  });

  it("creates one immutable intent and materializes one message/job", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const first = await ensureOrderConfirmationIntent(
        client,
        orderId,
        "https://shop.kapchi.test",
        "production",
      );
      const replay = await ensureOrderConfirmationIntent(
        client,
        orderId,
        "https://shop.kapchi.test",
        "production",
      );
      await client.query("commit");
      expect(first.created).toBe(true);
      expect(replay).toEqual({ created: false, id: first.id });
    } finally {
      client.release();
    }

    await pool.query(
      `update orders set customer_email = 'changed-profile@example.test' where id = $1`,
      [orderId],
    );
    const [claim] = await repository.claimMaterializationIntents("integration-worker", 1);
    expect(claim).toMatchObject({
      materializationAttemptCount: 1,
      orderId,
      recipientChannel: "email"
    });
    const rendered = renderNotification(claim.kind, claim.recipientChannel!, claim.payload);
    const messageId = await repository.materializeIntent({
      fromAddress: "orders@kapchi.test",
      intentId: claim.id,
      leaseOwner: claim.leaseOwner,
      rendered
    });

    const stored = await pool.query<{
      intent_count: number;
      job_count: number;
      message_count: number;
      to_address: string;
    }>(
      `select
         (select count(*)::integer from transactional_notification_intents where order_id = $1) as intent_count,
         (select count(*)::integer from order_messages where order_id = $1) as message_count,
         (select count(*)::integer from message_delivery_jobs where order_message_id = $2) as job_count,
         (select to_address from order_messages where id = $2) as to_address`,
      [orderId, messageId],
    );
    expect(stored.rows[0]).toEqual({
      intent_count: 1,
      job_count: 1,
      message_count: 1,
      to_address: "original-recipient@example.test"
    });

    const statuses = await repository.listByOrder(orderId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      deliveryAttemptCount: 0,
      materializationAttemptCount: 1,
      state: "queued"
    });
    expect(JSON.stringify(statuses)).not.toContain("original-recipient@example.test");
    expect(rendered.body).not.toContain("PRIVATE-CUSTOMIZATION");
  });

  it("makes a terminal materialization failure visible on the linked refund effect", async () => {
    const operationId = randomUUID();
    await pool.query(
      `update orders
          set customer_email = null, preferred_contact_method = 'email'
        where id = $1`,
      [orderId],
    );
    await pool.query(
      `insert into refund_operations (
         id, order_id, payment_intent_id, provider_account_id, livemode,
         amount_cents, currency, reason_code, origin, status,
         provider_refund_id, client_idempotency_key, provider_idempotency_key,
         request_fingerprint, succeeded_at, notification_requested
       ) values (
         $1::uuid, $2::uuid, $3, 'acct_test', false, 500, 'usd',
         'requested_by_customer', 'stripe_external', 'succeeded', $4,
         $5, $6, $7, now(), true
       )`,
      [
        operationId,
        orderId,
        `pi_${operationId}`,
        `re_${operationId}`,
        `client-${operationId}`,
        `provider-${operationId}`,
        "b".repeat(64)
      ],
    );
    const effect = await pool.query<{ id: string }>(
      `insert into refund_effects (
         refund_operation_id, effect_type, requested, status,
         idempotency_key, next_attempt_at
       ) values ($1::uuid, 'customer_notification', true, 'pending', $2, now())
       returning id`,
      [operationId, `effect-${operationId}`],
    );

    await expect(repository.promoteRefundEffect(effect.rows[0].id)).resolves.toEqual(
      expect.any(String),
    );
    const [claim] = await repository.claimMaterializationIntents(
      "missing-contact-worker",
      10,
    );
    expect(claim).toMatchObject({
      recipientChannel: null,
      recipientFailureCode: "MESSAGE_CONTACT_UNAVAILABLE"
    });
    await expect(repository.failMaterialization({
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE",
      intentId: claim.id,
      leaseOwner: claim.leaseOwner,
      retryable: false
    })).resolves.toBe(true);

    const state = await pool.query<{
      effect_code: string;
      effect_status: string;
      intent_code: string;
      intent_status: string;
    }>(
      `select effects.status::text as effect_status,
              effects.last_error_code as effect_code,
              intents.status::text as intent_status,
              intents.last_failure_code as intent_code
         from refund_effects effects
         join transactional_notification_intents intents
           on intents.id = effects.transactional_notification_intent_id
        where effects.id = $1::uuid`,
      [effect.rows[0].id],
    );
    expect(state.rows[0]).toEqual({
      effect_code: "MESSAGE_CONTACT_UNAVAILABLE",
      effect_status: "failed",
      intent_code: "MESSAGE_CONTACT_UNAVAILABLE",
      intent_status: "failed"
    });

    await pool.query("delete from refund_operations where id = $1::uuid", [operationId]);
  });
});
