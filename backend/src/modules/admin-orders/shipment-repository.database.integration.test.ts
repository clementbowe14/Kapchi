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

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminOrderShipmentRepository(pool);
    await pool.query(`insert into users (id, auth_provider, auth_subject, display_name) values ($1, 'clerk', $2, 'Shipment Admin')`, [userId, authSubject]);
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status, paid_at,
         shipping_name, shipping_address, subtotal_cents, total_cents, currency, revision
       ) values ($1, $2, 'ready_to_ship', 'paid', 'ready_to_ship', now(), 'Customer',
         '{"city":"Testville","country":"US"}'::jsonb, 0, 0, 'usd', 4)`,
      [orderId, `SHIP-${orderId}`],
    );
    await pool.query(
      `insert into order_fulfillments (
         id, order_id, fulfillment_number, status, ready_to_ship_at, order_snapshot,
         shipping_name_snapshot, shipping_address_snapshot
       ) values ($1, $2, 1, 'ready_to_ship', now(), '{}'::jsonb, 'Customer',
         '{"city":"Testville","country":"US"}'::jsonb)`,
      [fulfillmentId, orderId],
    );
  });

  afterAll(async () => {
    await pool?.query("delete from orders where id = $1", [orderId]);
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  it("commits one shipment, fulfillment/order transition, event, and durable replay receipt", async () => {
    const input = { carrier: "USPS", expectedRevision: 4, reason: "Carrier handoff", trackingNumber: "9400-TEST" };
    const actor = { authSubject, userId };
    const fingerprint = confirmShipmentFingerprint(orderId, input);
    const first = await repository.confirm(orderId, actor, input, "shipment-db-1", fingerprint);
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
              (select count(*)::integer from admin_order_mutation_receipts where order_id = orders.id) as receipt_count
       from orders join order_fulfillments fulfillments
         on fulfillments.order_id = orders.id and fulfillments.fulfillment_number = 1
       where orders.id = $1`,
      [orderId],
    );
    expect(stored.rows[0]).toMatchObject({
      event_count: 1, fulfillment_status: "shipped", primary_status: "shipped",
      receipt_count: 2, revision: 5, shipment_count: 1, status: "shipped"
    });
  });
});
