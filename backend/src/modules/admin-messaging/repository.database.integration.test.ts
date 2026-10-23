import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { MessagingError } from "./errors.js";
import { AdminMessagingRepository } from "./repository.js";
import { messagingPayloadHash } from "./webhook-signature.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("admin messaging database contract", () => {
  let pool: Pool;
  let repository: AdminMessagingRepository;
  const userId = randomUUID();
  const authSubject = `message-admin-${userId}`;
  const customerId = randomUUID();
  const contactId = randomUUID();
  const orderId = randomUUID();
  const publicOrderNumber = `KAP-MSG-${orderId.slice(0, 8)}`;
  const actor = { authSubject, userId };
  const senders = {
    email: "support@example.test",
    sms: "+15555550100"
  };

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminMessagingRepository(pool);
    await pool.query(
      `insert into users (id, auth_provider, auth_subject, email)
       values ($1::uuid, 'clerk', $2, 'admin@example.test')`,
      [userId, authSubject],
    );
    await pool.query(
      `insert into customers (
         id, email, phone, full_name, preferred_contact_method
       ) values ($1::uuid, 'customer@example.test', '+15555550199', 'Test Customer', 'email')`,
      [customerId],
    );
    await pool.query(
      `insert into customer_contacts (
         id, customer_id, contact_name, email, phone,
         preferred_contact_method, is_primary
       ) values (
         $1::uuid, $2::uuid, 'Test Customer', 'customer@example.test',
         '+15555550199', 'email', true
       )`,
      [contactId, customerId],
    );
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status,
         customer_id, customer_contact_id, customer_email, customer_phone,
         preferred_contact_method, shipping_name, subtotal_cents,
         shipping_cents, tax_cents, discount_cents, total_cents, currency,
         paid_at
       ) values (
         $1::uuid, $2, 'paid', 'paid', 'queued', $3::uuid, $4::uuid,
         'customer@example.test', '+15555550199', 'email', 'Test Customer',
         5000, 0, 0, 0, 5000, 'usd', now()
       )`,
      [orderId, publicOrderNumber, customerId, contactId],
    );
  });

  afterAll(async () => {
    await pool?.query("delete from refund_effects where refund_operation_id in (select id from refund_operations where order_id = $1)", [orderId]);
    await pool?.query("delete from refund_operations where order_id = $1", [orderId]);
    await pool?.query("delete from orders where id = $1", [orderId]);
    await pool?.query("delete from customer_contacts where id = $1", [contactId]);
    await pool?.query("delete from customers where id = $1", [customerId]);
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  it("queues one idempotent reply and completes its durable delivery job", async () => {
    const first = await repository.queueReply(
      orderId,
      actor,
      { body: "Your order is ready.", channel: "email", subject: "Order update" },
      `reply-${orderId}`,
      senders,
    );
    const replay = await repository.queueReply(
      orderId,
      actor,
      { body: "Your order is ready.", channel: "email", subject: "Order update" },
      `reply-${orderId}`,
      senders,
    );

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id } });
    await expect(repository.queueReply(
      orderId,
      actor,
      { body: "Different content", channel: "email" },
      `reply-${orderId}`,
      senders,
    )).rejects.toBeInstanceOf(MessagingError);

    const [job] = await repository.claimDeliveryJobs(10, "delivery-worker");
    expect(job?.message).toMatchObject({
      channel: "email",
      from: "support@example.test",
      to: "customer@example.test"
    });
    await repository.completeDelivery(
      job!,
      "delivery-worker",
      { messageId: "sandbox-message-1", provider: "sandbox" },
    );
    await expect(repository.detail(orderId)).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: first.message.id, status: "sent" })],
      status: "awaiting_customer"
    });
  });

  it("keeps internal notes private from delivery and preserves conversation state", async () => {
    const before = await repository.detail(orderId);
    const note = await repository.addNote(
      orderId,
      actor,
      { body: "Private production note" },
      `note-${orderId}`,
    );
    const after = await repository.detail(orderId);

    expect(note.message).toMatchObject({ channel: "internal_note", direction: "internal" });
    expect(after.status).toBe(before.status);
    expect(await repository.claimDeliveryJobs(10, "note-worker")).toEqual([]);
  });

  it("reopens a resolved conversation for a deduplicated verified inbound reply", async () => {
    const current = await repository.detail(orderId);
    await repository.updateConversation(orderId, actor, "resolve", current.version);
    const input = {
      body: "Thank you.",
      channel: "email" as const,
      eventId: `inbound-${orderId}`,
      from: "customer@example.test",
      providerMessageId: `provider-inbound-${orderId}`,
      threadKey: `kapchi-order:${orderId}`,
      timestamp: Math.floor(Date.now() / 1000),
      to: "support@example.test",
      type: "message.received" as const
    };
    const hash = messagingPayloadHash(input);

    await expect(repository.receiveWebhook("sandbox", input, hash)).resolves.toEqual({
      duplicate: false,
      status: "processed"
    });
    await expect(repository.receiveWebhook("sandbox", input, hash)).resolves.toEqual({
      duplicate: true,
      status: "processed"
    });
    await expect(repository.detail(orderId)).resolves.toMatchObject({
      adminUnread: true,
      status: "awaiting_admin"
    });
  });

  it("persists a rejected inbound event when the sender does not match the order", async () => {
    const input = {
      body: "Forged message",
      channel: "email" as const,
      eventId: `forged-${orderId}`,
      from: "attacker@example.test",
      providerMessageId: `provider-forged-${orderId}`,
      threadKey: `kapchi-order:${orderId}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: "message.received" as const
    };

    await expect(
      repository.receiveWebhook("sandbox", input, messagingPayloadHash(input)),
    ).resolves.toEqual({
      duplicate: false,
      errorCode: "CONTACT_MISMATCH",
      status: "rejected"
    });
    const receipt = await pool.query<{ error_code: string; status: string }>(
      `select status, error_code from messaging_webhook_events
       where provider = 'sandbox' and provider_event_id = $1`,
      [input.eventId],
    );
    expect(receipt.rows[0]).toEqual({
      error_code: "CONTACT_MISMATCH",
      status: "rejected"
    });
  });

  it("schedules refund notification independently and records terminal delivery failure", async () => {
    const operationId = randomUUID();
    await pool.query(
      `insert into refund_operations (
         id, order_id, payment_intent_id, provider_account_id, livemode,
         amount_cents, currency, reason_code, actor_user_id,
         actor_auth_subject, origin, status, provider_refund_id,
         client_idempotency_key, provider_idempotency_key,
         request_fingerprint, succeeded_at, notification_requested
       ) values (
         $1::uuid, $2::uuid, $3, 'acct_test', false, 1200, 'usd',
         'requested_by_customer', $4::uuid, $5, 'kapchi', 'succeeded',
         $6, $7, $8, $9, now(), true
       )`,
      [
        operationId,
        orderId,
        `pi_${operationId}`,
        userId,
        authSubject,
        `re_${operationId}`,
        `client-${operationId}`,
        `provider-${operationId}`,
        "a".repeat(64)
      ],
    );
    await pool.query(
      `insert into refund_effects (
         refund_operation_id, effect_type, requested, status, idempotency_key,
         next_attempt_at
       ) values ($1::uuid, 'customer_notification', true, 'pending', $2, now())`,
      [operationId, `effect-${operationId}`],
    );

    await expect(repository.scheduleRefundNotification(operationId, senders)).resolves.toBe(true);
    const jobs = await repository.claimDeliveryJobs(10, "refund-message-worker");
    const job = jobs.find((candidate) => candidate.message.subject?.includes(publicOrderNumber));
    expect(job).toBeDefined();
    await repository.completeDelivery(
      job!,
      "refund-message-worker",
      { messageId: `refund-provider-${operationId}`, provider: "sandbox" },
    );
    const failureEvent = {
      channel: "email" as const,
      errorCode: "RECIPIENT_REJECTED",
      eventId: `refund-failed-${operationId}`,
      providerMessageId: `refund-provider-${operationId}`,
      threadKey: `kapchi-order:${orderId}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: "message.failed" as const
    };
    await expect(repository.receiveWebhook(
      "sandbox",
      failureEvent,
      messagingPayloadHash(failureEvent),
    )).resolves.toEqual({ duplicate: false, status: "processed" });
    const effect = await pool.query<{ last_error_code: string; status: string }>(
      `select status, last_error_code from refund_effects
       where refund_operation_id = $1::uuid and effect_type = 'customer_notification'`,
      [operationId],
    );
    expect(effect.rows[0]).toEqual({
      last_error_code: "RECIPIENT_REJECTED",
      status: "failed"
    });
    const refund = await pool.query<{ status: string }>(
      "select status from refund_operations where id = $1::uuid",
      [operationId],
    );
    expect(refund.rows[0]?.status).toBe("succeeded");
  });
});
