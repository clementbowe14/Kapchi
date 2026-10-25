import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import {
  AdminInventoryRepository,
  inventoryRequestFingerprint
} from "./repository.js";
import type { InventoryActor } from "./types.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("AdminInventoryRepository database invariants", () => {
  let pool: Pool;
  let repository: AdminInventoryRepository;
  let actor: InventoryActor;
  const fabricIds: string[] = [];
  const listingIds: string[] = [];
  const cartIds: string[] = [];
  const orderIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminInventoryRepository(pool);
    const userId = randomUUID();
    userIds.push(userId);
    actor = { authSubject: `inventory-admin-${userId}`, userId };
    await pool.query(
      `insert into users (id, auth_provider, auth_subject) values ($1, 'clerk', $2)`,
      [userId, actor.authSubject],
    );
  });

  afterEach(async () => {
    if (fabricIds.length > 0) {
      await pool.query(
        "delete from fabric_inventory_events where fabric_id = any($1::uuid[])",
        [fabricIds],
      );
      await pool.query(
        "delete from fabric_reservations where fabric_id = any($1::uuid[])",
        [fabricIds],
      );
    }
    if (orderIds.length > 0) {
      await pool.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    if (cartIds.length > 0) {
      await pool.query("delete from carts where id = any($1::uuid[])", [cartIds]);
    }
    if (listingIds.length > 0) {
      await pool.query("delete from listings where id = any($1::uuid[])", [listingIds]);
    }
    if (fabricIds.length > 0) {
      await pool.query("delete from fabrics where id = any($1::uuid[])", [fabricIds]);
    }
    fabricIds.length = 0;
    listingIds.length = 0;
    cartIds.length = 0;
    orderIds.length = 0;
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await pool.query("delete from users where id = any($1::uuid[])", [userIds]);
    }
    await pool?.end();
  });

  async function createFabric(
    quantityOnHand: number,
    quantityReserved = 0,
    quantitySold = 0,
  ) {
    const id = randomUUID();
    fabricIds.push(id);
    await pool.query(
      `
        insert into fabrics (
          id, sku, name, material, quantity_on_hand, quantity_reserved, quantity_sold
        ) values ($1, $2, $3, 'Satin', $4, $5, $6)
      `,
      [id, `FAB-${id}`, `Fabric ${id}`, quantityOnHand, quantityReserved, quantitySold],
    );
    return id;
  }

  async function createListing(requiresFabric = true) {
    const id = randomUUID();
    listingIds.push(id);
    await pool.query(
      `
        insert into listings (
          id, slug, title, listing_type, status, base_price_cents, requires_fabric
        ) values ($1, $2, $3, 'graduation_stole', 'active', 5000, $4)
      `,
      [id, `listing-${id}`, `Listing ${id}`, requiresFabric],
    );
    return id;
  }

  async function createCart() {
    const id = randomUUID();
    cartIds.push(id);
    await pool.query(
      `insert into carts (id, guest_token_hash, status, expires_at)
       values ($1, $2, 'active', now() + interval '1 day')`,
      [id, `guest-${id}`],
    );
    return id;
  }

  async function createOrder(paymentStatus = "checkout_started") {
    const id = randomUUID();
    orderIds.push(id);
    await pool.query(
      `
        insert into orders (
          id, public_order_number, status, payment_status, fulfillment_status,
          subtotal_cents, total_cents, currency, paid_at
        ) values (
          $1,
          $2,
          case when $3 = 'paid' then 'paid'::order_status else 'pending_payment'::order_status end,
          $3::payment_status,
          'not_started',
          5000,
          5000,
          'usd',
          case when $3 = 'paid' then now() else null end
        )
      `,
      [id, `INV-${id}`, paymentStatus],
    );
    return id;
  }

  it("counts a cart-to-order reservation once and expires stale holds", async () => {
    const fabricId = await createFabric(10, 6);
    const firstListing = await createListing();
    const secondListing = await createListing();
    const untrackedListing = await createListing(false);
    const cartId = await createCart();
    const orderId = await createOrder();
    await pool.query(
      `insert into listing_fabrics (listing_id, fabric_id, active)
       values ($1, $3, true), ($2, $3, true)`,
      [firstListing, secondListing, fabricId],
    );
    await pool.query(
      `
        insert into fabric_reservations (
          fabric_id, cart_id, order_id, quantity, status, expires_at
        ) values
          ($1, $2, null, 2, 'active', now() + interval '1 hour'),
          ($1, $2, $3, 3, 'active', now() + interval '1 hour'),
          ($1, $2, null, 1, 'active', now() - interval '1 minute')
      `,
      [fabricId, cartId, orderId],
    );

    const report = await repository.list({
      fabricId,
      lowStockThreshold: 5,
      stock: "all"
    });
    const found = report.pools.find((entry) => entry.id === fabricId);

    expect(found).toMatchObject({
      availableQuantity: 5,
      cartHeldQuantity: 2,
      countedReservedQuantity: 5,
      orderReservedQuantity: 3,
      storedReservedQuantity: 5
    });
    expect(found?.linkedListings).toHaveLength(2);
    expect(report.pools.filter((entry) => entry.id === fabricId)).toHaveLength(1);
    expect(report.reconciliation).toEqual({ expiredCount: 1, releasedQuantity: 1 });
    expect(report.untrackedProducts.some((entry) => entry.id === untrackedListing)).toBe(true);
  });

  it("serializes competing reductions below committed stock", async () => {
    const fabricId = await createFabric(5, 3);
    const inputs = ["first", "second"].map((suffix) => {
      const input = { deltaOnHand: -2, reason: `Count correction ${suffix}` };
      return repository.adjustStock(
        fabricId,
        actor,
        input,
        `adjust-${fabricId}-${suffix}`,
        inventoryRequestFingerprint("fabric.adjust", fabricId, input),
      );
    });

    const results = await Promise.allSettled(inputs);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await pool.query<{ quantity_on_hand: number }>(
      "select quantity_on_hand from fabrics where id = $1",
      [fabricId],
    );
    expect(stored.rows[0].quantity_on_hand).toBe(3);
  });

  it("replays returned-unit restocks and rejects quantities above the order item", async () => {
    const fabricId = await createFabric(2, 0, 2);
    const orderId = await createOrder("paid");
    const orderItemId = randomUUID();
    await pool.query(
      `
        insert into order_items (
          id, order_id, fabric_id, quantity, unit_amount_cents,
          total_amount_cents, currency, listing_snapshot, customization_snapshot
        ) values ($1, $2, $3, 2, 2500, 5000, 'usd', '{}'::jsonb, '{}'::jsonb)
      `,
      [orderItemId, orderId, fabricId],
    );
    const input = {
      orderItemId,
      quantity: 1,
      reason: "Returned unused",
      usableUnitsConfirmed: true as const
    };
    const key = `restock-${orderItemId}`;
    const fingerprint = inventoryRequestFingerprint("fabric.restock", fabricId, input);

    const first = await repository.restockReturnedUnits(
      fabricId,
      actor,
      input,
      key,
      fingerprint,
    );
    const replay = await repository.restockReturnedUnits(
      fabricId,
      actor,
      input,
      key,
      fingerprint,
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toMatchObject({ quantityOnHand: 3, quantitySold: 1 });
    const excessive = {
      orderItemId,
      quantity: 2,
      reason: "Returned unused",
      usableUnitsConfirmed: true as const
    };
    await expect(repository.restockReturnedUnits(
      fabricId,
      actor,
      excessive,
      `${key}-excessive`,
      inventoryRequestFingerprint("fabric.restock", fabricId, excessive),
    )).rejects.toMatchObject({ code: "RETURN_QUANTITY_EXCEEDED" });
  });

  it("creates, links, updates and archives fabric with actor audit events", async () => {
    const listingId = await createListing();
    const createInput = {
      colorName: "Gold",
      material: "Satin",
      name: "Gold Satin",
      quantityOnHand: 8,
      sku: `FAB-GOLD-${randomUUID()}`
    };
    const created = await repository.createFabric(
      actor,
      createInput,
      `create-${createInput.sku}`,
      inventoryRequestFingerprint("fabric.create", "new", createInput),
    );
    fabricIds.push(created.value.id);
    const linkInput = { active: true, isDefault: true, sortOrder: 0 };
    await repository.linkListing(
      created.value.id,
      listingId,
      actor,
      linkInput,
      `link-${created.value.id}`,
      inventoryRequestFingerprint(
        "fabric.link",
        `${created.value.id}:${listingId}`,
        linkInput,
      ),
    );
    const updateInput = { name: "Archived Gold Satin", status: "archived" as const };
    const updated = await repository.updateFabric(
      created.value.id,
      actor,
      updateInput,
      `archive-${created.value.id}`,
      inventoryRequestFingerprint("fabric.update", created.value.id, updateInput),
    );

    expect(updated.value).toMatchObject({
      name: "Archived Gold Satin",
      status: "archived"
    });
    expect(updated.value.linkedListings).toEqual([
      expect.objectContaining({ id: listingId, isDefault: true })
    ]);
    const events = await pool.query<{ actor_user_id: string; event_type: string }>(
      `select actor_user_id, event_type from fabric_inventory_events
       where fabric_id = $1 order by created_at, id`,
      [created.value.id],
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "fabric_created",
      "listing_linked",
      "fabric_archived"
    ]);
    expect(events.rows.every((event) => event.actor_user_id === actor.userId)).toBe(true);
  });
});
