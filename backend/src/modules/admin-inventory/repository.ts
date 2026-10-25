import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { InventoryError } from "./errors.js";
import { expireStaleFabricReservations } from "./lifecycle.js";
import type {
  FabricAdjustmentInput,
  FabricCreateInput,
  FabricListingLinkInput,
  FabricRestockInput,
  FabricUpdateInput,
  InventoryActor,
  InventoryListQuery
} from "./types.js";

type FabricRow = QueryResultRow & {
  available_quantity: number;
  cart_held_quantity: number;
  color_hex: string | null;
  color_name: string | null;
  counted_reserved_quantity: number;
  created_at: Date | string;
  id: string;
  linked_listings: Array<{
    active: boolean;
    id: string;
    isDefault: boolean;
    slug: string;
    sortOrder: number;
    title: string;
  }> | string;
  material: string | null;
  name: string;
  order_reserved_quantity: number;
  quantity_on_hand: number;
  quantity_sold: number;
  sku: string | null;
  status: "active" | "archived";
  stored_reserved_quantity: number;
  updated_at: Date | string;
};

type EventRow = QueryResultRow & {
  fabric_id: string;
  request_fingerprint: string;
};

type InventoryEventType =
  | "fabric_created"
  | "fabric_updated"
  | "fabric_archived"
  | "listing_linked"
  | "stock_adjusted"
  | "return_restocked";

const fabricSelect = `
  select
    availability.*,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', l.id,
          'slug', l.slug,
          'title', l.title,
          'active', lf.active,
          'isDefault', lf.is_default,
          'sortOrder', lf.sort_order
        ) order by lf.sort_order, l.title, l.id
      )
      from listing_fabrics lf
      join listings l on l.id = lf.listing_id
      where lf.fabric_id = availability.id
    ), '[]'::jsonb) as linked_listings
  from fabric_inventory_availability availability
`;

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function integer(value: number | string, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${field} exceeds the safe integer range.`);
  }
  return parsed;
}

function linkedListings(value: FabricRow["linked_listings"]) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function fabric(row: FabricRow) {
  const availableQuantity = integer(row.available_quantity, "available quantity");
  return {
    availabilityStatus: availableQuantity === 0
      ? "out_of_stock" as const
      : availableQuantity <= 5
        ? "low_stock" as const
        : "available" as const,
    availableQuantity,
    cartHeldQuantity: integer(row.cart_held_quantity, "cart held quantity"),
    colorHex: row.color_hex,
    colorName: row.color_name,
    countedReservedQuantity: integer(
      row.counted_reserved_quantity,
      "counted reserved quantity",
    ),
    createdAt: iso(row.created_at),
    id: row.id,
    linkedListings: linkedListings(row.linked_listings),
    material: row.material,
    name: row.name,
    orderReservedQuantity: integer(
      row.order_reserved_quantity,
      "order reserved quantity",
    ),
    quantityOnHand: integer(row.quantity_on_hand, "quantity on hand"),
    quantitySold: integer(row.quantity_sold, "quantity sold"),
    sku: row.sku,
    status: row.status,
    storedReservedQuantity: integer(
      row.stored_reserved_quantity,
      "stored reserved quantity",
    ),
    updatedAt: iso(row.updated_at)
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function inventoryRequestFingerprint(
  operation: string,
  target: string,
  input: unknown,
) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ input, operation, target })))
    .digest("hex");
}

async function transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export class AdminInventoryRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(authSubject: string): Promise<InventoryActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `
        select id from users
        where auth_provider = 'clerk' and auth_subject = $1 and disabled_at is null
        limit 1
      `,
      [authSubject],
    );
    return result.rows[0]
      ? { authSubject, userId: result.rows[0].id }
      : null;
  }

  async list(query: InventoryListQuery) {
    return transaction(this.pool, async (client) => {
      const expired = await expireStaleFabricReservations(client, query.fabricId);
      const search = query.search?.trim() || null;
      const result = await client.query<FabricRow>(
        `
          ${fabricSelect}
          where ($1::uuid is null or availability.id = $1::uuid)
            and ($2::uuid is null or exists (
              select 1 from listing_fabrics filter_link
              where filter_link.fabric_id = availability.id
                and filter_link.listing_id = $2::uuid
            ))
            and ($3::text is null or
              availability.name ilike '%' || $3 || '%'
              or availability.sku ilike '%' || $3 || '%'
              or exists (
                select 1
                from listing_fabrics search_link
                join listings search_listing on search_listing.id = search_link.listing_id
                where search_link.fabric_id = availability.id
                  and (search_listing.title ilike '%' || $3 || '%'
                    or search_listing.slug ilike '%' || $3 || '%')
              )
            )
            and (
              $4 = 'all'
              or ($4 = 'out' and availability.available_quantity = 0)
              or ($4 = 'low' and availability.available_quantity between 1 and $5)
              or ($4 = 'available' and availability.available_quantity > $5)
            )
          order by availability.name, availability.sku nulls last, availability.id
        `,
        [
          query.fabricId ?? null,
          query.listingId ?? null,
          search,
          query.stock,
          query.lowStockThreshold
        ],
      );
      const untracked = await client.query<{
        id: string;
        listing_type: string;
        slug: string;
        title: string;
      }>(
        `
          select id, slug, title, listing_type
          from listings
          where requires_fabric = false and status <> 'archived'
            and ($1::uuid is null or id = $1::uuid)
            and ($2::text is null or title ilike '%' || $2 || '%' or slug ilike '%' || $2 || '%')
          order by title, id
        `,
        [query.listingId ?? null, search],
      );
      const pools = result.rows.map(fabric).map((pool) => ({
        ...pool,
        availabilityStatus: pool.availableQuantity === 0
          ? "out_of_stock" as const
          : pool.availableQuantity <= query.lowStockThreshold
            ? "low_stock" as const
            : "available" as const,
        orderDrillDown: { fabricId: pool.id }
      }));

      return {
        capabilities: {
          finishedProductInventory: {
            available: false,
            reason: "FINISHED_PRODUCT_LEDGER_UNAVAILABLE"
          },
          returnedUnitRestock: true,
          sharedFabricPools: true
        },
        filters: {
          lowStockThreshold: query.lowStockThreshold,
          stock: query.stock
        },
        pools,
        reconciliation: expired,
        summary: {
          availableQuantity: pools.reduce((sum, pool) => sum + pool.availableQuantity, 0),
          cartHeldQuantity: pools.reduce((sum, pool) => sum + pool.cartHeldQuantity, 0),
          lowStockPoolCount: pools.filter((pool) => pool.availabilityStatus === "low_stock").length,
          orderReservedQuantity: pools.reduce(
            (sum, pool) => sum + pool.orderReservedQuantity,
            0,
          ),
          outOfStockPoolCount: pools.filter((pool) => pool.availabilityStatus === "out_of_stock").length,
          poolCount: pools.length,
          quantityOnHand: pools.reduce((sum, pool) => sum + pool.quantityOnHand, 0),
          quantitySold: pools.reduce((sum, pool) => sum + pool.quantitySold, 0)
        },
        untrackedProducts: untracked.rows.map((row) => ({
          availability: {
            reason: "FINISHED_PRODUCT_LEDGER_UNAVAILABLE",
            status: "untracked" as const
          },
          id: row.id,
          listingType: row.listing_type,
          slug: row.slug,
          title: row.title
        }))
      };
    });
  }

  async createFabric(
    actor: InventoryActor,
    input: FabricCreateInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const replay = await this.replay(client, idempotencyKey, fingerprint);
      if (replay) return { replayed: true, value: await this.loadFabric(client, replay.fabric_id) };

      try {
        const result = await client.query<{ id: string }>(
          `
            insert into fabrics (
              sku, name, color_name, color_hex, material, quantity_on_hand
            ) values ($1, $2, $3, $4, $5, $6)
            returning id
          `,
          [
            input.sku,
            input.name,
            input.colorName ?? null,
            input.colorHex ?? null,
            input.material ?? null,
            input.quantityOnHand
          ],
        );
        const fabricId = result.rows[0]!.id;
        await this.recordEvent(client, {
          actor,
          deltaOnHand: input.quantityOnHand,
          eventType: "fabric_created",
          fabricId,
          fingerprint,
          idempotencyKey,
          metadata: { sku: input.sku },
          reason: "Initial fabric inventory"
        });
        return { replayed: false, value: await this.loadFabric(client, fabricId) };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new InventoryError("FABRIC_SKU_CONFLICT", "Fabric SKU already exists.", 409);
        }
        throw error;
      }
    });
  }

  async updateFabric(
    fabricId: string,
    actor: InventoryActor,
    input: FabricUpdateInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const replay = await this.replay(client, idempotencyKey, fingerprint);
      if (replay) return { replayed: true, value: await this.loadFabric(client, replay.fabric_id) };
      let result;
      try {
        result = await client.query<{ id: string }>(
          `
            update fabrics
            set
              sku = case when $2 then $3 else sku end,
              name = case when $4 then $5 else name end,
              color_name = case when $6 then $7 else color_name end,
              color_hex = case when $8 then $9 else color_hex end,
              material = case when $10 then $11 else material end,
              status = case when $12 then $13::fabric_status else status end
            where id = $1::uuid
            returning id
          `,
          [
            fabricId,
            input.sku !== undefined,
            input.sku ?? null,
            input.name !== undefined,
            input.name ?? null,
            input.colorName !== undefined,
            input.colorName ?? null,
            input.colorHex !== undefined,
            input.colorHex ?? null,
            input.material !== undefined,
            input.material ?? null,
            input.status !== undefined,
            input.status ?? null
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new InventoryError("FABRIC_SKU_CONFLICT", "Fabric SKU already exists.", 409);
        }
        throw error;
      }
      if (!result.rows[0]) throw new InventoryError("FABRIC_NOT_FOUND", "Fabric not found.", 404);
      await this.recordEvent(client, {
        actor,
        eventType: input.status === "archived" ? "fabric_archived" : "fabric_updated",
        fabricId,
        fingerprint,
        idempotencyKey,
        metadata: { fields: Object.keys(input).sort() },
        reason: input.status === "archived" ? "Fabric archived" : "Fabric metadata updated"
      });
      return { replayed: false, value: await this.loadFabric(client, fabricId) };
    });
  }

  async adjustStock(
    fabricId: string,
    actor: InventoryActor,
    input: FabricAdjustmentInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const replay = await this.replay(client, idempotencyKey, fingerprint);
      if (replay) return { replayed: true, value: await this.loadFabric(client, replay.fabric_id) };
      await expireStaleFabricReservations(client, fabricId);
      const result = await client.query<{ id: string }>(
        `
          update fabrics
          set quantity_on_hand = quantity_on_hand + $2
          where id = $1::uuid
            and quantity_on_hand + $2 >= quantity_reserved
            and quantity_on_hand + $2 >= 0
          returning id
        `,
        [fabricId, input.deltaOnHand],
      );
      if (!result.rows[0]) {
        const exists = await client.query(`select id from fabrics where id = $1::uuid`, [fabricId]);
        if (!exists.rows[0]) throw new InventoryError("FABRIC_NOT_FOUND", "Fabric not found.", 404);
        throw new InventoryError(
          "INVENTORY_REDUCTION_CONFLICT",
          "Stock cannot be reduced below currently reserved inventory.",
          409,
        );
      }
      await this.recordEvent(client, {
        actor,
        deltaOnHand: input.deltaOnHand,
        eventType: "stock_adjusted",
        fabricId,
        fingerprint,
        idempotencyKey,
        metadata: {},
        reason: input.reason
      });
      return { replayed: false, value: await this.loadFabric(client, fabricId) };
    });
  }

  async linkListing(
    fabricId: string,
    listingId: string,
    actor: InventoryActor,
    input: FabricListingLinkInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const replay = await this.replay(client, idempotencyKey, fingerprint);
      if (replay) return { replayed: true, value: await this.loadFabric(client, replay.fabric_id) };
      const locked = await client.query<{ fabric_id: string; listing_id: string }>(
        `
          select f.id as fabric_id, l.id as listing_id
          from fabrics f
          cross join listings l
          where f.id = $1::uuid and l.id = $2::uuid and l.requires_fabric = true
          for update of f, l
        `,
        [fabricId, listingId],
      );
      if (!locked.rows[0]) {
        throw new InventoryError(
          "FABRIC_LISTING_NOT_FOUND",
          "Fabric and a fabric-backed listing are required.",
          404,
        );
      }
      if (input.isDefault) {
        await client.query(
          `update listing_fabrics set is_default = false where listing_id = $1::uuid`,
          [listingId],
        );
      }
      await client.query(
        `
          insert into listing_fabrics (
            listing_id, fabric_id, active, is_default, sort_order
          ) values ($1::uuid, $2::uuid, $3, $4, $5)
          on conflict (listing_id, fabric_id) do update set
            active = excluded.active,
            is_default = excluded.is_default,
            sort_order = excluded.sort_order
        `,
        [listingId, fabricId, input.active, input.isDefault, input.sortOrder],
      );
      await this.recordEvent(client, {
        actor,
        eventType: "listing_linked",
        fabricId,
        fingerprint,
        idempotencyKey,
        listingId,
        metadata: input,
        reason: input.active ? "Listing linked to fabric" : "Listing fabric link disabled"
      });
      return { replayed: false, value: await this.loadFabric(client, fabricId) };
    });
  }

  async restockReturnedUnits(
    fabricId: string,
    actor: InventoryActor,
    input: FabricRestockInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const replay = await this.replay(client, idempotencyKey, fingerprint);
      if (replay) return { replayed: true, value: await this.loadFabric(client, replay.fabric_id) };
      const item = await client.query<{
        fabric_id: string | null;
        payment_status: string;
        quantity: number;
      }>(
        `
          select oi.fabric_id, oi.quantity, o.payment_status
          from order_items oi
          join orders o on o.id = oi.order_id
          where oi.id = $1::uuid
          for update of oi, o
        `,
        [input.orderItemId],
      );
      const row = item.rows[0];
      if (!row || row.fabric_id !== fabricId) {
        throw new InventoryError(
          "RETURN_ITEM_MISMATCH",
          "Returned units must identify an order item using this fabric.",
          409,
        );
      }
      if (!["paid", "partially_refunded", "refunded"].includes(row.payment_status)) {
        throw new InventoryError(
          "RETURN_ITEM_NOT_PAID",
          "Only units from a paid order can be restocked.",
          409,
        );
      }
      const prior = await client.query<{ quantity: number }>(
        `
          select coalesce(sum(delta_on_hand), 0)::integer as quantity
          from fabric_inventory_events
          where order_item_id = $1::uuid and event_type = 'return_restocked'
        `,
        [input.orderItemId],
      );
      if (Number(prior.rows[0]?.quantity ?? 0) + input.quantity > row.quantity) {
        throw new InventoryError(
          "RETURN_QUANTITY_EXCEEDED",
          "Restocked units cannot exceed the purchased order item quantity.",
          409,
        );
      }
      const updated = await client.query<{ id: string }>(
        `
          update fabrics
          set quantity_on_hand = quantity_on_hand + $2,
              quantity_sold = quantity_sold - $2
          where id = $1::uuid and quantity_sold >= $2
          returning id
        `,
        [fabricId, input.quantity],
      );
      if (!updated.rows[0]) {
        throw new InventoryError(
          "SOLD_QUANTITY_CONFLICT",
          "Recorded sold inventory cannot cover this restock.",
          409,
        );
      }
      await this.recordEvent(client, {
        actor,
        deltaOnHand: input.quantity,
        deltaSold: -input.quantity,
        eventType: "return_restocked",
        fabricId,
        fingerprint,
        idempotencyKey,
        metadata: {},
        orderItemId: input.orderItemId,
        reason: input.reason
      });
      return { replayed: false, value: await this.loadFabric(client, fabricId) };
    });
  }

  private async replay(client: PoolClient, key: string, fingerprint: string) {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [key],
    );
    const result = await client.query<EventRow>(
      `
        select fabric_id, request_fingerprint
        from fabric_inventory_events
        where idempotency_key = $1
        for update
      `,
      [key],
    );
    const existing = result.rows[0];
    if (!existing) return null;
    if (existing.request_fingerprint !== fingerprint) {
      throw new InventoryError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used for a different inventory operation.",
        409,
      );
    }
    return existing;
  }

  private async loadFabric(client: PoolClient, fabricId: string) {
    const result = await client.query<FabricRow>(
      `${fabricSelect} where availability.id = $1::uuid`,
      [fabricId],
    );
    if (!result.rows[0]) throw new InventoryError("FABRIC_NOT_FOUND", "Fabric not found.", 404);
    return fabric(result.rows[0]);
  }

  private async recordEvent(
    client: PoolClient,
    input: {
      actor: InventoryActor;
      deltaOnHand?: number;
      deltaSold?: number;
      eventType: InventoryEventType;
      fabricId: string;
      fingerprint: string;
      idempotencyKey: string;
      listingId?: string;
      metadata: unknown;
      orderItemId?: string;
      reason: string;
    },
  ) {
    await client.query(
      `
        insert into fabric_inventory_events (
          fabric_id, listing_id, order_item_id, event_type, source,
          actor_user_id, actor_auth_subject, idempotency_key,
          request_fingerprint, delta_on_hand, delta_sold, reason, metadata
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4, 'admin',
          $5::uuid, $6, $7, $8, $9, $10, $11, $12::jsonb
        )
      `,
      [
        input.fabricId,
        input.listingId ?? null,
        input.orderItemId ?? null,
        input.eventType,
        input.actor.userId,
        input.actor.authSubject,
        input.idempotencyKey,
        input.fingerprint,
        input.deltaOnHand ?? 0,
        input.deltaSold ?? 0,
        input.reason,
        JSON.stringify(input.metadata)
      ],
    );
  }
}

export type AdminInventoryReader = Pick<
  AdminInventoryRepository,
  | "adjustStock"
  | "createFabric"
  | "linkListing"
  | "list"
  | "resolveActor"
  | "restockReturnedUnits"
  | "updateFabric"
>;
