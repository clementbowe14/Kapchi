import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { CheckoutRepository } from "./checkout-repository.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("CheckoutRepository catalog failure marker", () => {
  let cartIds: string[] = [];
  let orderIds: string[] = [];
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  afterEach(async () => {
    if (orderIds.length > 0) {
      await pool.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    if (cartIds.length > 0) {
      await pool.query("delete from carts where id = any($1::uuid[])", [cartIds]);
    }
    cartIds = [];
    orderIds = [];
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists one event for concurrent deterministic failures", async () => {
    const cartId = randomUUID();
    const orderId = randomUUID();
    cartIds.push(cartId);
    orderIds.push(orderId);
    const userId = `catalog-failure-integration-${cartId}`;

    await pool.query(
      `
        insert into carts (
          id, user_id, status, currency, subtotal_cents, expires_at
        ) values ($1, $2, 'checkout_started', 'usd', 4500, now() + interval '1 hour')
      `,
      [cartId, userId],
    );
    await pool.query(
      `
        insert into orders (
          id, public_order_number, user_id, cart_id, status, payment_status,
          subtotal_cents, total_cents, currency
        ) values (
          $1, $2, $3, $4, 'pending_payment', 'checkout_started',
          4500, 4500, 'usd'
        )
      `,
      [orderId, `CATALOG-${orderId}`, userId, cartId],
    );

    const repository = new CheckoutRepository(pool);
    const dispositions = await Promise.all([
      repository.markCatalogUnavailable(orderId),
      repository.markCatalogUnavailable(orderId)
    ]);
    expect(dispositions.filter((result) => result.orderRetired)).toHaveLength(1);

    const order = await pool.query<{
      payment_status: string;
      status: string;
      stripe_checkout_session_id: string | null;
    }>(
      `select status, payment_status, stripe_checkout_session_id
       from orders where id = $1`,
      [orderId],
    );
    expect(order.rows).toEqual([{
      payment_status: "failed",
      status: "cancelled",
      stripe_checkout_session_id: null
    }]);

    const events = await pool.query<{
      actor_type: string;
      event_type: string;
      metadata: Record<string, unknown>;
      to_value: string | null;
    }>(
      `select actor_type, event_type, to_value, metadata
       from order_events
       where order_id = $1 and event_type = 'checkout.catalog_unavailable'`,
      [orderId],
    );
    expect(events.rows).toEqual([{
      actor_type: "system",
      event_type: "checkout.catalog_unavailable",
      metadata: {
        reason: "missing_checkout_line_item_price",
        source: "stripe_checkout_session"
      },
      to_value: "failed"
    }]);

    const cart = await pool.query<{ status: string }>(
      "select status from carts where id = $1",
      [cartId],
    );
    expect(cart.rows).toEqual([{ status: "active" }]);
  });

  it("abandons a stale checkout cart when the owner has an active replacement", async () => {
    const staleCartId = randomUUID();
    const activeCartId = randomUUID();
    const orderId = randomUUID();
    const userId = `catalog-failure-sibling-${staleCartId}`;
    cartIds.push(staleCartId, activeCartId);
    orderIds.push(orderId);

    await pool.query(
      `
        insert into carts (
          id, user_id, status, currency, subtotal_cents, expires_at
        ) values
          ($1, $3, 'checkout_started', 'usd', 4500, now() + interval '1 hour'),
          ($2, $3, 'active', 'usd', 9000, now() + interval '1 hour')
      `,
      [staleCartId, activeCartId, userId],
    );
    await pool.query(
      `
        insert into orders (
          id, public_order_number, user_id, cart_id, status, payment_status,
          subtotal_cents, total_cents, currency
        ) values (
          $1, $2, $3, $4, 'pending_payment', 'failed', 4500, 4500, 'usd'
        )
      `,
      [orderId, `CATALOG-${orderId}`, userId, staleCartId],
    );

    const disposition = await new CheckoutRepository(pool).markCatalogUnavailable(orderId);

    expect(disposition).toEqual({
      cartId: staleCartId,
      cartStatus: "abandoned",
      orderRetired: true
    });
    const carts = await pool.query<{ id: string; status: string }>(
      "select id, status from carts where id = any($1::uuid[]) order by id",
      [[staleCartId, activeCartId]],
    );
    expect(new Map(carts.rows.map((cart) => [cart.id, cart.status]))).toEqual(
      new Map([
        [staleCartId, "abandoned"],
        [activeCartId, "active"]
      ]),
    );

    const order = await pool.query<{ payment_status: string; status: string }>(
      "select status, payment_status from orders where id = $1",
      [orderId],
    );
    expect(order.rows).toEqual([{ payment_status: "failed", status: "cancelled" }]);
  });
});
