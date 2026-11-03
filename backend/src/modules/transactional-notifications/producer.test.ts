import { describe, expect, it, vi } from "vitest";
import {
  ensureOrderShipmentIntent,
  ensureTransactionalNotificationIntent,
  NotificationIdempotencyConflictError,
  payloadHash
} from "./producer.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const shipmentId = "22222222-2222-4222-8222-222222222222";
const payload = {
  lookupUrl: "https://shop.kapchi.test/orders",
  publicOrderNumber: "KAP-1001"
};
const recipient = {
  address: "customer@example.test",
  channel: "email" as const,
  failureCode: null
};

describe("transactional notification intent producers", () => {
  it("inserts one deterministic intent", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "intent-1" }] }));
    await expect(ensureTransactionalNotificationIntent({ query } as never, {
      idempotencyKey: `transactional:order-cancelled:${orderId}`,
      kind: "order.cancelled",
      orderId,
      payload,
      recipient,
      sourceId: orderId,
      sourceType: "order"
    })).resolves.toEqual({ created: true, id: "intent-1" });
    const calls = query.mock.calls as unknown[][];
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining([
      orderId,
      "order.cancelled",
      `transactional:order-cancelled:${orderId}`,
      payloadHash(payload),
      "email",
      "customer@example.test"
    ]));
  });

  it("recovers an exact replay and rejects a conflicting replay", async () => {
    const exactRow = {
      id: "intent-1",
      kind: "order.cancelled",
      order_id: orderId,
      payload_hash: payloadHash(payload),
      recipient_address: recipient.address,
      recipient_channel: recipient.channel,
      recipient_failure_code: null,
      source_id: orderId,
      source_type: "order"
    };
    const exact = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [exactRow] });
    await expect(ensureTransactionalNotificationIntent({ query: exact } as never, {
      idempotencyKey: `transactional:order-cancelled:${orderId}`,
      kind: "order.cancelled",
      orderId,
      payload,
      recipient,
      sourceId: orderId,
      sourceType: "order"
    })).resolves.toEqual({ created: false, id: "intent-1" });

    const conflict = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...exactRow, payload_hash: "0".repeat(64) }] });
    await expect(ensureTransactionalNotificationIntent({ query: conflict } as never, {
      idempotencyKey: `transactional:order-cancelled:${orderId}`,
      kind: "order.cancelled",
      orderId,
      payload,
      recipient,
      sourceId: orderId,
      sourceType: "order"
    })).rejects.toBeInstanceOf(NotificationIdempotencyConflictError);
  });

  it("recomputes tracking links instead of reading a persisted URL", async () => {
    const query = vi.fn(async (statement: unknown) => {
      const sql = String(statement);
      if (sql.includes("from orders")) return { rows: [{
        currency: "usd",
        customer_email: "customer@example.test",
        customer_phone: null,
        id: orderId,
        preferred_contact_method: "email",
        public_order_number: "KAP-1001",
        total_cents: 1000
      }] };
      if (sql.includes("from shipments")) return { rows: [{
        carrier: "UPS",
        tracking_number: "1Z TEST"
      }] };
      if (sql.includes("insert into transactional_notification_intents")) {
        return { rows: [{ id: "intent-ship" }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    await ensureOrderShipmentIntent(
      { query } as never,
      orderId,
      shipmentId,
      "https://shop.kapchi.test/path",
      "production",
    );
    const calls = query.mock.calls as unknown[][];
    const insert = calls.find(([sql]) =>
      String(sql).includes("insert into transactional_notification_intents"));
    const values = insert?.[1] as unknown[] | undefined;
    const stored = JSON.parse(String(values?.[5]));
    expect(stored.trackingUrl).toMatch(/^https:\/\/www\.ups\.com\/track/);
    expect(stored.lookupUrl).toBe("https://shop.kapchi.test/orders");
    expect(String(calls[1]?.[0])).not.toContain("tracking_url");
  });
});
