import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ensureOrderShipmentIntent } from "../transactional-notifications/producer.js";
import { AdminOrderShipmentRepository, confirmShipmentFingerprint } from "./shipment-repository.js";

vi.mock("../transactional-notifications/producer.js", () => ({
  ensureOrderShipmentIntent: vi.fn(async () => ({ created: true, id: "intent" }))
}));

const orderId = "11111111-1111-4111-8111-111111111111";
const actor = { authSubject: "user_admin", userId: "22222222-2222-4222-8222-222222222222" };
const input = { carrier: "united states postal service", carrierService: "Priority Mail", expectedRevision: 4, reason: "Handed to carrier", trackingNumber: "9400 1118-9922" };

function database(handler: (sql: string, values?: unknown[]) => { rows: unknown[] }) {
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    const sql = String(statement);
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
    return handler(sql, values);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query };
}

describe("shipment confirmation repository", () => {
  it("atomically ships the order and fulfillment and records a receipt", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("from orders where id")) return { rows: [{
        fulfillment_status: "ready_to_ship", id: orderId, paid_at: "2026-11-02T12:00:00Z",
        payment_status: "paid", revision: 4, shipped_at: null,
        shipping_address: { city: "Testville" }, shipping_name: "Customer", status: "ready_to_ship"
      }] };
      if (sql.includes("from order_fulfillments")) return { rows: [{
        fulfillment_number: 1, id: "33333333-3333-4333-8333-333333333333",
        shipping_address_snapshot: { city: "Testville" }, shipping_name_snapshot: "Customer",
        status: "ready_to_ship"
      }] };
      if (sql.includes("from shipping_export_active_memberships")) return { rows: [] };
      if (sql.includes("from shipping_export_batch_items")) return { rows: [] };
      if (sql.includes("from shipments")) return { rows: [] };
      if (sql.includes("insert into shipments")) return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] };
      if (sql.includes("update order_fulfillments")) return { rows: [] };
      if (sql.includes("update orders")) return { rows: [{ revision: 5 }] };
      if (sql.includes("insert into order_events")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }] };
      if (sql.includes("insert into admin_order_mutation_receipts")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new AdminOrderShipmentRepository(db.pool);
    const fingerprint = confirmShipmentFingerprint(orderId, input);

    const result = await repository.confirm(orderId, actor, input, "confirm-1", fingerprint);

    expect(result).toMatchObject({
      command: "confirm_shipment", fulfillmentStatus: "shipped", orderStatus: "shipped",
      replayed: false, revision: 5,
      shipment: {
        carrier: "USPS",
        trackingNumber: "9400 1118-9922",
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201118-9922"
      }
    });
    const receipt = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into admin_order_mutation_receipts"));
    expect(receipt?.[1]).toEqual(expect.arrayContaining([orderId, "confirm-1", fingerprint]));
    expect(db.query).toHaveBeenCalledWith("commit");
    expect(ensureOrderShipmentIntent).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      "44444444-4444-4444-8444-444444444444",
      "http://localhost:3000",
      "test",
    );
  });

  it("replays an identical receipt without reading or changing the order", async () => {
    const stored = {
      command: "confirm_shipment", fulfillmentStatus: "shipped", orderId,
      orderStatus: "shipped", paymentStatus: "paid", replayed: false, revision: 5,
      shipment: { carrier: "USPS", carrierService: null, id: "44444444-4444-4444-8444-444444444444", shippedAt: "2026-11-02T18:00:00.000Z", trackingNumber: "9400", trackingUrl: null },
      transitionedAt: "2026-11-02T18:00:00.000Z"
    };
    const fingerprint = confirmShipmentFingerprint(orderId, input);
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [{ request_fingerprint: fingerprint, result: stored, source_event_id: "event" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(new AdminOrderShipmentRepository(db.pool).confirm(orderId, actor, input, "same", fingerprint))
      .resolves.toEqual({ ...stored, replayed: true });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update orders"))).toBe(false);
    expect(ensureOrderShipmentIntent).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      stored.shipment.id,
      "http://localhost:3000",
      "test",
    );
  });

  it("rejects reuse of a receipt key with different input", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [{ request_fingerprint: "different", result: {}, source_event_id: "event" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(new AdminOrderShipmentRepository(db.pool).confirm(
      orderId, actor, input, "same", confirmShipmentFingerprint(orderId, input),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(db.query).toHaveBeenCalledWith("rollback");
  });

  it("preserves a pending shipment with different tracking and rejects the command", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("from orders where id")) return { rows: [{
        fulfillment_status: "ready_to_ship", id: orderId, paid_at: "2026-11-02T12:00:00Z",
        payment_status: "paid", revision: 4, shipped_at: null,
        shipping_address: { city: "Testville" }, shipping_name: "Customer", status: "ready_to_ship"
      }] };
      if (sql.includes("from order_fulfillments")) return { rows: [{
        fulfillment_number: 1, id: "33333333-3333-4333-8333-333333333333",
        shipping_address_snapshot: { city: "Testville" }, shipping_name_snapshot: "Customer",
        status: "ready_to_ship"
      }] };
      if (sql.includes("from shipping_export_active_memberships")) return { rows: [] };
      if (sql.includes("from shipping_export_batch_items")) return { rows: [] };
      if (sql.includes("from shipments")) return { rows: [{
        carrier: "UPS", id: "44444444-4444-4444-8444-444444444444",
        shipment_number: 1, status: "label_purchased", tracking_number: "DIFFERENT"
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(new AdminOrderShipmentRepository(db.pool).confirm(
      orderId, actor, input, "conflict", confirmShipmentFingerprint(orderId, input),
    )).rejects.toMatchObject({ code: "SHIPMENT_ALREADY_CONFIRMED", statusCode: 409 });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update shipments"))).toBe(false);
    expect(db.query).toHaveBeenCalledWith("rollback");
  });

  it("allocates after immutable voided history instead of overwriting it", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("from orders where id")) return { rows: [{
        fulfillment_status: "ready_to_ship", id: orderId, paid_at: "2026-11-02T12:00:00Z",
        payment_status: "paid", revision: 4, shipped_at: null,
        shipping_address: { city: "Testville" }, shipping_name: "Customer", status: "ready_to_ship"
      }] };
      if (sql.includes("from order_fulfillments")) return { rows: [{
        fulfillment_number: 1, id: "33333333-3333-4333-8333-333333333333",
        shipping_address_snapshot: { city: "Testville" }, shipping_name_snapshot: "Customer",
        status: "ready_to_ship"
      }] };
      if (sql.includes("from shipping_export_active_memberships")) return { rows: [] };
      if (sql.includes("from shipping_export_batch_items")) return { rows: [] };
      if (sql.includes("from shipments")) return { rows: [{
        carrier: null, id: "44444444-4444-4444-8444-444444444444",
        shipment_number: 3, status: "voided", tracking_number: null
      }] };
      if (sql.includes("insert into shipments")) return { rows: [{ id: "66666666-6666-4666-8666-666666666666" }] };
      if (sql.includes("update order_fulfillments")) return { rows: [] };
      if (sql.includes("update orders")) return { rows: [{ revision: 5 }] };
      if (sql.includes("insert into order_events")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }] };
      if (sql.includes("insert into admin_order_mutation_receipts")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await new AdminOrderShipmentRepository(db.pool).confirm(
      orderId, actor, input, "after-void", confirmShipmentFingerprint(orderId, input),
    );
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into shipments"));
    expect(insert?.[1]?.[2]).toBe(4);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update shipments"))).toBe(false);
  });

  it("requires the exact shipment ID for an active export membership", async () => {
    const shipmentId = "44444444-4444-4444-8444-444444444444";
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("from orders where id")) return { rows: [{
        fulfillment_status: "ready_to_ship", id: orderId, paid_at: "2026-11-02T12:00:00Z",
        payment_status: "paid", revision: 4, shipped_at: null,
        shipping_address: { city: "Testville" }, shipping_name: "Customer", status: "ready_to_ship"
      }] };
      if (sql.includes("from order_fulfillments")) return { rows: [{
        fulfillment_number: 1, id: "33333333-3333-4333-8333-333333333333",
        shipping_address_snapshot: { city: "Testville" }, shipping_name_snapshot: "Customer",
        status: "ready_to_ship"
      }] };
      if (sql.includes("from shipments")) return { rows: [{
        active_shipping_export_batch_id: "77777777-7777-4777-8777-777777777777",
        carrier: null, id: shipmentId, shipment_number: 1,
        status: "label_pending", tracking_number: null
      }] };
      if (sql.includes("from shipping_export_active_memberships")) return { rows: [{
        batch_id: "77777777-7777-4777-8777-777777777777", shipment_id: shipmentId, status: "prepared"
      }] };
      if (sql.includes("from shipping_export_batch_items")) return { rows: [{ shipment_id: shipmentId }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(new AdminOrderShipmentRepository(db.pool).confirm(
      orderId, actor, input, "exported-confirm", confirmShipmentFingerprint(orderId, input),
    )).rejects.toMatchObject({ code: "SHIPMENT_ID_REQUIRED", statusCode: 409 });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update shipments"))).toBe(false);
  });

  it("rejects confirmation for a cancelled or released export shipment", async () => {
    const shipmentId = "44444444-4444-4444-8444-444444444444";
    const exportedInput = { ...input, shipmentId };
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("from admin_order_mutation_receipts")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("from orders where id")) return { rows: [{
        fulfillment_status: "ready_to_ship", id: orderId, paid_at: "2026-11-02T12:00:00Z",
        payment_status: "paid", revision: 4, shipped_at: null,
        shipping_address: { city: "Testville" }, shipping_name: "Customer", status: "ready_to_ship"
      }] };
      if (sql.includes("from order_fulfillments")) return { rows: [{
        fulfillment_number: 1, id: "33333333-3333-4333-8333-333333333333",
        shipping_address_snapshot: { city: "Testville" }, shipping_name_snapshot: "Customer",
        status: "ready_to_ship"
      }] };
      if (sql.includes("from shipments")) return { rows: [{
        active_shipping_export_batch_id: null, carrier: null, id: shipmentId,
        shipment_number: 1, status: "label_pending", tracking_number: null
      }] };
      if (sql.includes("from shipping_export_active_memberships")) return { rows: [] };
      if (sql.includes("from shipping_export_batch_items")) return { rows: [{ shipment_id: shipmentId }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(new AdminOrderShipmentRepository(db.pool).confirm(
      orderId,
      actor,
      exportedInput,
      "released-export-confirm",
      confirmShipmentFingerprint(orderId, exportedInput),
    )).rejects.toMatchObject({ code: "SHIPMENT_NOT_FOUND", statusCode: 409 });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update shipments"))).toBe(false);
  });
});
