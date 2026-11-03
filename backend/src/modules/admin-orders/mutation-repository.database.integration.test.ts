import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import {
  adminOrderMutationFingerprint,
  AdminOrderMutationRepository
} from "./mutation-repository.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("admin order mutation database", () => {
  let pool: Pool;
  let repository: AdminOrderMutationRepository;
  const userId = randomUUID();
  const authSubject = `admin-order-mutation-${userId}`;
  const orderIds: string[] = [];

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminOrderMutationRepository(pool);
    await pool.query(
      `insert into users (id, auth_provider, auth_subject, display_name)
       values ($1, 'clerk', $2, 'Order Admin')`,
      [userId, authSubject],
    );
  });

  afterAll(async () => {
    if (orderIds.length > 0) {
      await pool?.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  async function paidOrder() {
    const orderId = randomUUID();
    orderIds.push(orderId);
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          paid_at, shipping_name, shipping_address, shipping_address_status,
          subtotal_cents, total_cents, currency
        ) values (
          $1, $2, 'paid', 'paid', 'queued', now(), 'Test Customer',
          '{"line1":"1 Test Way","city":"Testville","state":"MA","postalCode":"02108","country":"US"}'::jsonb,
          'valid', 0, 0, 'usd'
        )
      `,
      [orderId, `MUTATION-${orderId}`],
    );
    return orderId;
  }

  it("serializes replay, rejects stale writes, and orders actor-attributed events", async () => {
    const orderId = await paidOrder();
    const actor = await repository.resolveActor(authSubject);
    expect(actor).toEqual({ authSubject, userId });
    const startInput = { expectedRevision: 0, reason: "Production started" };
    const startFingerprint = adminOrderMutationFingerprint(
      "start_production",
      orderId,
      startInput,
    );

    const starts = await Promise.all([
      repository.mutate(
        orderId,
        "start_production",
        actor!,
        startInput,
        "start-production-once",
        startFingerprint,
      ),
      repository.mutate(
        orderId,
        "start_production",
        actor!,
        startInput,
        "start-production-once",
        startFingerprint,
      )
    ]);
    expect(starts.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(starts.map((result) => result.revision))).toEqual(new Set([1]));

    const readyInput = { expectedRevision: 1, reason: "Quality check passed" };
    await expect(repository.mutate(
      orderId,
      "mark_ready_to_ship",
      actor!,
      { ...readyInput, expectedRevision: 0 },
      "ready-stale",
      adminOrderMutationFingerprint(
        "mark_ready_to_ship",
        orderId,
        { ...readyInput, expectedRevision: 0 },
      ),
    )).rejects.toMatchObject({
      code: "ORDER_REVISION_CONFLICT",
      statusCode: 409
    });

    const ready = await repository.mutate(
      orderId,
      "mark_ready_to_ship",
      actor!,
      readyInput,
      "ready-once",
      adminOrderMutationFingerprint("mark_ready_to_ship", orderId, readyInput),
    );
    expect(ready).toMatchObject({
      fulfillmentStatus: "ready_to_ship",
      orderStatus: "ready_to_ship",
      replayed: false,
      revision: 2
    });

    const stored = await pool.query<{
      fulfillment_status: string;
      ready_to_ship_at: Date;
      revision: number;
      status: string;
    }>(
      `select status, fulfillment_status, revision, ready_to_ship_at
       from orders where id = $1`,
      [orderId],
    );
    expect(stored.rows[0]).toMatchObject({
      fulfillment_status: "ready_to_ship",
      revision: 2,
      status: "ready_to_ship"
    });
    expect(stored.rows[0].ready_to_ship_at).toBeInstanceOf(Date);
    const primary = await pool.query<{ status: string; ready_to_ship_at: Date }>(
      `select status, ready_to_ship_at from order_fulfillments
       where order_id = $1 and fulfillment_number = 1`,
      [orderId],
    );
    expect(primary.rows[0]).toMatchObject({ status: "ready_to_ship" });
    expect(primary.rows[0].ready_to_ship_at).toBeInstanceOf(Date);

    const events = await pool.query<{
      actor_auth_subject: string;
      actor_user_id: string;
      event_type: string;
    }>(
      `
        select actor_id as actor_auth_subject, actor_user_id, event_type
        from order_events where order_id = $1
        order by created_at, id
      `,
      [orderId],
    );
    expect(events.rows).toEqual([
      {
        actor_auth_subject: authSubject,
        actor_user_id: userId,
        event_type: "order.production_started"
      },
      {
        actor_auth_subject: authSubject,
        actor_user_id: userId,
        event_type: "order.ready_to_ship"
      }
    ]);
  });
});
