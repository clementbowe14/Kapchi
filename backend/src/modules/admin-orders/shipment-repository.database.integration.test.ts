import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { AdminOrderShipmentRepository, confirmShipmentFingerprint } from "./shipment-repository.js";

loadBackendEnvironment();
const integrationDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("shipment confirmation database transaction", () => {
  let pool: Pool;
  let repository: AdminOrderShipmentRepository;
  const userId = randomUUID();
  const authSubject = `shipment-admin-${userId}`;
  const orderId = randomUUID();
  const fulfillmentId = randomUUID();
  const shipmentId = randomUUID();
  const batchId = randomUUID();

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminOrderShipmentRepository(pool);
    await pool.query(`insert into users (id, auth_provider, auth_subject, display_name) values ($1, 'clerk', $2, 'Shipment Admin')`, [userId, authSubject]);
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status, paid_at,
         customer_email, preferred_contact_method, shipping_name, shipping_address,
         subtotal_cents, total_cents, currency, revision
       ) values ($1, $2, 'ready_to_ship', 'paid', 'ready_to_ship', now(), $3, 'email',
         'Customer', '{"city":"Testville","country":"US"}'::jsonb,
         0, 0, 'usd', 4)`,
      [orderId, `SHIP-${orderId}`, "shipment-customer@example.test"],
    );
    await pool.query(
      `insert into order_fulfillments (
         id, order_id, fulfillment_number, status, ready_to_ship_at, order_snapshot,
         shipping_name_snapshot, shipping_address_snapshot
       ) values ($1, $2, 1, 'ready_to_ship', now(), '{}'::jsonb, 'Customer',
         '{"city":"Testville","country":"US"}'::jsonb)`,
      [fulfillmentId, orderId],
    );
    await pool.query(
      `insert into shipping_export_batches (
         id, actor_user_id, actor_auth_subject, request_id, idempotency_key_hash,
         request_fingerprint, row_count, file_sha256, file_size_bytes
       ) values ($1, $2, $3, 'shipment-integration', $4, $5, 1, $6, 1)`,
      [batchId, userId, authSubject, "a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    await pool.query(
      `insert into shipments (
         id, order_id, fulfillment_id, shipment_number, status,
         ship_to_name_snapshot, ship_to_address_snapshot,
         active_shipping_export_batch_id, exported_at
       ) values ($1, $2, $3, 1, 'label_pending', 'Customer',
                 '{"city":"Testville","country":"US"}'::jsonb, $4, now())`,
      [shipmentId, orderId, fulfillmentId, batchId],
    );
    await pool.query(
      `insert into shipping_export_batch_items (
         batch_id, order_id, shipment_id, row_number, row_snapshot,
         row_sha256, reconciliation_token_hash
       ) values ($1, $2, $3, 1, '{}'::jsonb, $4, $5)`,
      [batchId, orderId, shipmentId, "d".repeat(64), "e".repeat(64)],
    );
    await pool.query(
      `insert into shipping_export_active_memberships (batch_id, order_id, shipment_id)
       values ($1, $2, $3)`,
      [batchId, orderId, shipmentId],
    );
  });

  afterAll(async () => {
    await pool?.query("delete from shipping_export_active_memberships where batch_id = $1", [batchId]);
    await pool?.query("delete from shipping_export_batch_items where batch_id = $1", [batchId]);
    await pool?.query("delete from shipping_export_batches where id = $1", [batchId]);
    await pool?.query("delete from orders where id = $1", [orderId]);
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  it("commits one shipment, fulfillment/order transition, event, and durable replay receipt", async () => {
    const input = { carrier: "USPS", expectedRevision: 4, reason: "Carrier handoff", shipmentId, trackingNumber: "9400-TEST" };
    const actor = { authSubject, userId };
    const fingerprint = confirmShipmentFingerprint(orderId, input);
    const first = await repository.confirm(orderId, actor, input, "shipment-db-1", fingerprint);
    await pool.query(
      `delete from transactional_notification_intents where order_id = $1`,
      [orderId],
    );
    const replay = await repository.confirm(orderId, actor, input, "shipment-db-1", fingerprint);
    const semanticReplay = await repository.confirm(orderId, actor, input, "shipment-db-2", fingerprint);

    expect(first).toMatchObject({ replayed: false, revision: 5, orderStatus: "shipped" });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(semanticReplay).toEqual({ ...first, replayed: true });
    const stored = await pool.query(
      `select orders.status, orders.fulfillment_status, orders.revision,
              fulfillments.status as primary_status,
              (select count(*)::integer from shipments where order_id = orders.id) as shipment_count,
              (select count(*)::integer from order_events where order_id = orders.id and event_type = 'order.shipment_confirmed') as event_count,
              (select count(*)::integer from admin_order_mutation_receipts where order_id = orders.id) as receipt_count,
              (select count(*)::integer from transactional_notification_intents
                where order_id = orders.id and kind = 'order.shipped') as notification_count
       from orders join order_fulfillments fulfillments
         on fulfillments.order_id = orders.id and fulfillments.fulfillment_number = 1
       where orders.id = $1`,
      [orderId],
    );
    expect(stored.rows[0]).toMatchObject({
      event_count: 1, fulfillment_status: "shipped", primary_status: "shipped",
      notification_count: 1, receipt_count: 2, revision: 5,
      shipment_count: 1, status: "shipped"
    });
    const membership = await pool.query(
      `select order_id from shipping_export_active_memberships where order_id = $1`,
      [orderId],
    );
    expect(membership.rows).toEqual([]);
  });
});
