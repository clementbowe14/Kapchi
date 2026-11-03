import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { TransactionalNotificationRepository } from "./repository.js";

const intentId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";

function database(handler: (sql: string, values?: unknown[]) => { rowCount?: number; rows: unknown[] }) {
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    const sql = String(statement);
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
    return handler(sql, values);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query
  } as unknown as Pool;
  return { pool, query };
}

describe("transactional notification worker repository", () => {
  it("claims ready and expired leased work with a bounded lease", async () => {
    const db = database((sql) => {
      if (sql.startsWith("update transactional_notification_intents")) return { rows: [] };
      if (sql.includes("with candidates")) return { rows: [{
        id: intentId,
        kind: "order.confirmed",
        lease_owner: "worker-1",
        materialization_attempt_count: 2,
        order_id: orderId,
        payload: { lookupUrl: "https://shop.test/orders", publicOrderNumber: "KAP-1" },
        recipient_channel: "email",
        recipient_failure_code: null
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new TransactionalNotificationRepository(
      db.pool,
      "https://shop.test",
      "production",
    );
    await expect(repository.claimMaterializationIntents("worker-1", 500)).resolves.toEqual([{
      id: intentId,
      kind: "order.confirmed",
      leaseOwner: "worker-1",
      materializationAttemptCount: 2,
      orderId,
      payload: { lookupUrl: "https://shop.test/orders", publicOrderNumber: "KAP-1" },
      recipientChannel: "email",
      recipientFailureCode: null
    }]);
    const claim = db.query.mock.calls.find(([sql]) => String(sql).includes("with candidates"));
    expect(claim?.[1]).toEqual(["worker-1", 100]);
    expect(String(claim?.[0])).toContain("status = 'leased' and lease_expires_at <= now()");
  });

  it("materializes conversation, message, job, and intent in one transaction", async () => {
    const db = database((sql) => {
      if (sql.includes("from transactional_notification_intents") && sql.includes("for update")) {
        return { rows: [{
          id: intentId,
          kind: "order.confirmed",
          lease_owner: "worker-1",
          materialization_attempt_count: 1,
          order_id: orderId,
          payload: {},
          recipient_address: "customer@example.test",
          recipient_channel: "email",
          recipient_failure_code: null
        }] };
      }
      if (sql.includes("insert into order_conversations")) return { rows: [{ id: "conversation" }] };
      if (sql.includes("insert into order_messages")) return { rows: [{ id: messageId }] };
      if (sql.includes("insert into message_delivery_jobs")) return { rows: [], rowCount: 1 };
      if (sql.includes("select order_message_id from message_delivery_jobs")) {
        return { rows: [{ order_message_id: messageId }] };
      }
      if (sql.includes("update transactional_notification_intents")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new TransactionalNotificationRepository(db.pool, "https://shop.test", "production");
    await expect(repository.materializeIntent({
      fromAddress: "orders@kapchi.test",
      intentId,
      leaseOwner: "worker-1",
      rendered: { body: "Safe body", subject: "Safe subject" }
    })).resolves.toBe(messageId);
    const messageInsert = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into order_messages"));
    expect(JSON.parse(String(messageInsert?.[1]?.[8]))).toEqual({
      transactionalNotificationIntentId: intentId
    });
    expect(db.query).toHaveBeenCalledWith("commit");
  });

  it("returns only safe status fields and canonicalizes arbitrary provider errors", async () => {
    const db = database((sql) => {
      if (sql.includes("from transactional_notification_intents")) return { rows: [{
        channel: "email",
        created_at: "2026-11-03T00:00:00Z",
        delivery_attempt_count: 3,
        failed_at: "2026-11-03T00:05:00Z",
        failure_code: "private provider response containing customer@example.test",
        id: intentId,
        kind: "order.confirmed",
        materialization_attempt_count: 1,
        public_order_number: "KAP-1",
        queued_at: "2026-11-03T00:01:00Z",
        state: "failed",
        succeeded_at: null,
        updated_at: "2026-11-03T00:05:00Z"
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const statuses = await new TransactionalNotificationRepository(
      db.pool,
      "https://shop.test",
      "production",
    ).listByOrder(orderId);
    expect(statuses[0]).toEqual(expect.objectContaining({
      deliveryAttemptCount: 3,
      failureCode: "MESSAGE_PROVIDER_FAILED",
      materializationAttemptCount: 1
    }));
    expect(JSON.stringify(statuses)).not.toContain("customer@example.test");
    expect(statuses[0]).not.toHaveProperty("recipientAddress");
    expect(statuses[0]).not.toHaveProperty("payload");
  });
});
