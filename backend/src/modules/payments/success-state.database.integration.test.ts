import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { handlePaymentIntentSucceeded } from "./success-state.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("successful payment fabric inventory conversion", () => {
  let pool: Pool;
  const fabricId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const reservationId = randomUUID();
  const paymentIntentId = `pi_inventory_${randomUUID()}`;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    await pool.query(
      `
        insert into fabrics (
          id, sku, name, quantity_on_hand, quantity_reserved, quantity_sold
        ) values ($1, $2, 'Payment Fabric', 5, 2, 0)
      `,
      [fabricId, `FAB-PAY-${fabricId}`],
    );
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          subtotal_cents, total_cents, currency, stripe_payment_intent_id
        ) values (
          $1, $2, 'pending_payment', 'checkout_started', 'not_started',
          5000, 5000, 'usd', $3
        )
      `,
      [orderId, `PAY-${orderId}`, paymentIntentId],
    );
    await pool.query(
      `
        insert into order_items (
          id, order_id, fabric_id, quantity, unit_amount_cents,
          total_amount_cents, currency, listing_snapshot, customization_snapshot
        ) values ($1, $2, $3, 2, 2500, 5000, 'usd', '{}'::jsonb, '{}'::jsonb)
      `,
      [orderItemId, orderId, fabricId],
    );
    await pool.query(
      `
        insert into fabric_reservations (
          id, fabric_id, order_id, order_item_id, quantity, status, expires_at
        ) values ($1, $2, $3, $4, 2, 'active', now() + interval '1 hour')
      `,
      [reservationId, fabricId, orderId, orderItemId],
    );
  });

  afterAll(async () => {
    await pool.query("delete from fabric_inventory_events where fabric_id = $1", [fabricId]);
    await pool.query("delete from fabric_reservations where id = $1", [reservationId]);
    await pool.query("delete from orders where id = $1", [orderId]);
    await pool.query("delete from fabrics where id = $1", [fabricId]);
    await pool?.end();
  });

  it("atomically consumes inventory and remains idempotent on webhook replay", async () => {
    const client = await pool.connect();
    try {
      await expect(handlePaymentIntentSucceeded(client, {
        id: paymentIntentId,
        metadata: { order_id: orderId }
      })).resolves.toEqual({ outcome: "updated", orderId });
      await expect(handlePaymentIntentSucceeded(client, {
        id: paymentIntentId,
        metadata: { order_id: orderId }
      })).resolves.toEqual({ outcome: "already_paid", orderId });
    } finally {
      client.release();
    }

    const inventory = await pool.query<{
      quantity_on_hand: number;
      quantity_reserved: number;
      quantity_sold: number;
    }>(
      `select quantity_on_hand, quantity_reserved, quantity_sold
       from fabrics where id = $1`,
      [fabricId],
    );
    expect(inventory.rows[0]).toEqual({
      quantity_on_hand: 3,
      quantity_reserved: 0,
      quantity_sold: 2
    });
    const reservation = await pool.query<{ status: string }>(
      "select status from fabric_reservations where id = $1",
      [reservationId],
    );
    expect(reservation.rows[0].status).toBe("converted");
    const events = await pool.query<{ count: number }>(
      `select count(*)::integer as count from fabric_inventory_events
       where order_item_id = $1 and event_type = 'payment_consumed'`,
      [orderItemId],
    );
    expect(events.rows[0].count).toBe(1);
  });
});
