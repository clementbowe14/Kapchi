import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AdminOrderError } from "./errors.js";
import type {
  AdminOrderDetail,
  AdminOrderItem,
  AdminOrderSearchPage,
  AdminOrderSearchQuery,
  AdminOrderSummary,
  AdminOrderTimelineEntry,
  AdminOrderTimelinePage,
  AdminOrderTimelineQuery,
  CustomerSnapshot,
  PaymentSummary,
  ProductionFieldAvailability
} from "./types.js";

type Queryable = Pick<Pool, "query"> | PoolClient;

type OrderRow = QueryResultRow & {
  cancelled_at: Date | string | null;
  captured_amount_cents: number | string | null;
  captured_currency: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  currency: string;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  discount_cents: number | string;
  fulfillment_status: AdminOrderSummary["fulfillmentStatus"];
  id: string;
  item_count: number | string;
  mismatched_refund_count: number | string;
  paid_at: Date | string | null;
  payment_status: AdminOrderSummary["paymentStatus"];
  pending_refund_cents: number | string;
  preferred_contact_method: CustomerSnapshot["preferredContactMethod"];
  public_order_number: string;
  revision: number;
  shipped_at: Date | string | null;
  shipping_address: Record<string, unknown> | null;
  shipping_name: string | null;
  status: AdminOrderSummary["status"];
  succeeded_refund_cents: number | string;
  total_cents: number | string;
  total_quantity: number | string;
  updated_at: Date | string;
};

type ItemRow = QueryResultRow & {
  asset_status: string | null;
  currency: string;
  customization_asset_id: string | null;
  customization_snapshot: Record<string, unknown>;
  fabric_snapshot: Record<string, unknown> | null;
  fabric_status: string | null;
  id: string;
  listing_id: string | null;
  listing_price_variant_id: string | null;
  listing_snapshot: Record<string, unknown>;
  listing_status: string | null;
  production_estimate_snapshot: Record<string, unknown> | null;
  production_notes: string | null;
  production_priority_code: string | null;
  quantity: number;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
  total_amount_cents: number;
  unit_amount_cents: number;
};

type TimelineRow = QueryResultRow & {
  actor_display_name: string | null;
  actor_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  id: string;
  kind: AdminOrderTimelineEntry["kind"];
  occurred_at: Date | string;
  payload: Record<string, unknown>;
  source_rank: number;
  visibility: AdminOrderTimelineEntry["visibility"];
};

const orderColumns = `
  orders.id,
  orders.public_order_number,
  orders.revision,
  orders.status,
  orders.payment_status,
  orders.fulfillment_status,
  orders.currency,
  orders.discount_cents,
  orders.total_cents,
  orders.shipping_name,
  orders.shipping_address,
  orders.paid_at,
  orders.cancelled_at,
  orders.shipped_at,
  orders.completed_at,
  orders.created_at,
  orders.updated_at,
  coalesce(orders.shipping_name, contacts.contact_name, customers.full_name) as customer_name,
  coalesce(orders.customer_email, contacts.email, customers.email) as customer_email,
  coalesce(orders.customer_phone, contacts.phone, customers.phone) as customer_phone,
  coalesce(
    orders.preferred_contact_method,
    contacts.preferred_contact_method,
    customers.preferred_contact_method
  ) as preferred_contact_method,
  coalesce(items.item_count, 0)::text as item_count,
  coalesce(items.total_quantity, 0)::text as total_quantity,
  reconciliation.captured_amount_cents,
  reconciliation.currency as captured_currency,
  coalesce(refunds.succeeded_refund_cents, 0)::text as succeeded_refund_cents,
  coalesce(refunds.pending_refund_cents, 0)::text as pending_refund_cents,
  coalesce(refunds.mismatched_refund_count, 0)::text as mismatched_refund_count
`;

const orderJoins = `
  left join customers on customers.id = orders.customer_id
  left join customer_contacts contacts on contacts.id = orders.customer_contact_id
  left join payment_reconciliation_state reconciliation on reconciliation.order_id = orders.id
  left join lateral (
    select count(*)::bigint as item_count, coalesce(sum(quantity), 0)::bigint as total_quantity
    from order_items where order_id = orders.id
  ) items on true
  left join lateral (
    select
      coalesce(sum(amount_cents) filter (
        where status = 'succeeded' and currency = orders.currency
      ), 0)::bigint as succeeded_refund_cents,
      coalesce(sum(amount_cents) filter (
        where status = 'pending' and currency = orders.currency
      ), 0)::bigint as pending_refund_cents,
      count(*) filter (where currency <> orders.currency)::bigint as mismatched_refund_count
    from refund_operations where order_id = orders.id
  ) refunds on true
`;

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeInteger(value: number | string | null, field: string) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${field} exceeds the safe integer range.`);
  }
  return parsed;
}

function customer(row: OrderRow): CustomerSnapshot {
  return {
    email: row.customer_email,
    name: row.customer_name,
    phone: row.customer_phone,
    preferredContactMethod: row.preferred_contact_method
  };
}

function payment(row: OrderRow): PaymentSummary {
  const succeeded = safeInteger(row.succeeded_refund_cents, "succeeded refunds");
  const pending = safeInteger(row.pending_refund_cents, "pending refunds");
  const mismatch = safeInteger(row.mismatched_refund_count, "refund currency mismatch") > 0
    || (row.captured_currency !== null && row.captured_currency !== row.currency);
  const captured = row.captured_amount_cents === null
    ? null
    : safeInteger(row.captured_amount_cents, "captured amount");

  return {
    captured: captured === null || mismatch
      ? null
      : { amountMinor: captured, currency: row.currency },
    currencyIntegrity: mismatch
      ? "mismatch"
      : captured === null
        ? "unavailable"
        : "consistent",
    pendingRefunds: { amountMinor: pending, currency: row.currency },
    refundableBalance: captured === null || mismatch
      ? null
      : {
          amountMinor: Math.max(0, captured - succeeded - pending),
          currency: row.currency
        },
    succeededRefunds: { amountMinor: succeeded, currency: row.currency }
  };
}

function summary(row: OrderRow): AdminOrderSummary {
  return {
    createdAt: iso(row.created_at)!,
    customer: customer(row),
    discount: {
      amountMinor: safeInteger(row.discount_cents, "discount"),
      currency: row.currency
    },
    fulfillmentStatus: row.fulfillment_status,
    id: row.id,
    itemCount: safeInteger(row.item_count, "item count"),
    payment: payment(row),
    paymentStatus: row.payment_status,
    publicOrderNumber: row.public_order_number,
    revision: row.revision,
    status: row.status,
    total: {
      amountMinor: safeInteger(row.total_cents, "order total"),
      currency: row.currency
    },
    totalQuantity: safeInteger(row.total_quantity, "total quantity"),
    updatedAt: iso(row.updated_at)!
  };
}

function jsonObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function storedField(
  snapshot: Record<string, unknown>,
  keys: string[],
): { availability: ProductionFieldAvailability; value: unknown } {
  for (const key of keys) {
    if (!Object.hasOwn(snapshot, key)) continue;
    const value = snapshot[key];
    if (value === null || value === "") {
      return { availability: "not_selected", value: null };
    }
    return { availability: "present", value };
  }
  return { availability: "not_stored", value: null };
}

function orderItem(row: ItemRow): AdminOrderItem {
  const customization = jsonObject(row.customization_snapshot);
  const line1 = storedField(customization, ["line1"]);
  const line2 = storedField(customization, ["line2"]);
  const font = storedField(customization, ["font", "fontOption", "fontOptionId"]);
  const trim = storedField(customization, ["trim", "trimOption", "trimOptionId"]);
  const placement = storedField(customization, ["placement", "imagePlacement", "textPlacement"]);
  const snapshotAsset = typeof customization.imageAssetId === "string"
    ? customization.imageAssetId
    : null;
  const assetId = row.customization_asset_id ?? snapshotAsset;

  return {
    catalogReference: {
      fabricStatus: row.fabric_status,
      listingStatus: row.listing_status
    },
    currency: row.currency,
    customizationAsset: {
      id: assetId,
      recordStatus: row.asset_status,
      unavailableReason: assetId === null
        ? "ASSET_NOT_SELECTED"
        : row.asset_status === null
          ? "ASSET_RECORD_MISSING"
          : null
    },
    id: row.id,
    listingId: row.listing_id,
    listingPriceVariantId: row.listing_price_variant_id,
    production: {
      availability: {
        font: font.availability,
        placement: placement.availability,
        text: line1.availability === "present" || line2.availability === "present"
          ? "present"
          : line1.availability === "not_selected" || line2.availability === "not_selected"
            ? "not_selected"
            : "not_stored",
        trim: trim.availability
      },
      estimateSnapshot: row.production_estimate_snapshot,
      font: font.value,
      placement: placement.value,
      priorityCode: row.production_priority_code,
      text: {
        line1: typeof line1.value === "string" ? line1.value : null,
        line2: typeof line2.value === "string" ? line2.value : null
      },
      trim: trim.value
    },
    productionNotes: row.production_notes,
    quantity: row.quantity,
    snapshots: {
      customization,
      fabric: row.fabric_snapshot,
      listing: jsonObject(row.listing_snapshot),
      variant: {
        currency: row.currency,
        listingPriceVariantId: row.listing_price_variant_id,
        stripePriceId: row.stripe_price_id,
        stripeProductId: row.stripe_product_id,
        unitAmountMinor: row.unit_amount_cents
      }
    },
    total: { amountMinor: row.total_amount_cents, currency: row.currency },
    unitPrice: { amountMinor: row.unit_amount_cents, currency: row.currency }
  };
}

function encode(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeOrderCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
      sort?: unknown;
    };
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id) ||
      (parsed.sort !== "created_asc" && parsed.sort !== "created_desc")
    ) throw new Error("invalid");
    return { createdAt: parsed.createdAt, id: parsed.id, sort: parsed.sort };
  } catch {
    throw new AdminOrderError("INVALID_CURSOR", "Order cursor is invalid.", 400);
  }
}

function decodeTimelineCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      id?: unknown;
      occurredAt?: unknown;
      rank?: unknown;
    };
    if (
      typeof parsed.occurredAt !== "string" ||
      Number.isNaN(Date.parse(parsed.occurredAt)) ||
      typeof parsed.id !== "string" ||
      typeof parsed.rank !== "number" ||
      !Number.isInteger(parsed.rank)
    ) throw new Error("invalid");
    return { id: parsed.id, occurredAt: parsed.occurredAt, rank: parsed.rank };
  } catch {
    throw new AdminOrderError("INVALID_CURSOR", "Timeline cursor is invalid.", 400);
  }
}

export function escapeOrderSearch(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function readOnlyTransaction<T>(
  pool: Pick<Pool, "connect">,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
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

export interface AdminOrderReader {
  detail(orderId: string): Promise<AdminOrderDetail>;
  search(query: AdminOrderSearchQuery): Promise<AdminOrderSearchPage>;
  timeline(
    orderId: string,
    query: AdminOrderTimelineQuery,
  ): Promise<AdminOrderTimelinePage>;
}

export class AdminOrderRepository implements AdminOrderReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async search(query: AdminOrderSearchQuery): Promise<AdminOrderSearchPage> {
    const cursor = query.cursor ? decodeOrderCursor(query.cursor) : null;
    if (cursor && cursor.sort !== query.sort) {
      throw new AdminOrderError(
        "INVALID_CURSOR",
        "Order cursor does not match the requested sort.",
        400,
      );
    }
    const search = query.search?.trim().toLowerCase();
    const pattern = search ? `%${escapeOrderSearch(search)}%` : null;
    const normalizedPattern = search
      ? `%${escapeOrderSearch(search.replace(/\s+/g, ""))}%`
      : null;
    const ascending = query.sort === "created_asc";
    const comparator = ascending ? ">" : "<";
    const direction = ascending ? "asc" : "desc";
    const client = await this.pool.connect();
    try {
      const result = await client.query<OrderRow>(
        `
          select ${orderColumns}
          from orders
          ${orderJoins}
          where (
            $1::text is null
            or lower(orders.public_order_number) like $1 escape '\\'
            or lower(concat_ws(' ', orders.shipping_name, contacts.contact_name, customers.full_name)) like $1 escape '\\'
            or lower(regexp_replace(
              concat_ws(' ', orders.customer_email, contacts.email, customers.email),
              '\\s+', '', 'g'
            )) like $2 escape '\\'
          )
            and ($3::date is null or orders.created_at >= ($3::date::timestamp at time zone 'UTC'))
            and ($4::date is null or orders.created_at < (($4::date + 1)::timestamp at time zone 'UTC'))
            and ($5::order_status is null or orders.status = $5)
            and ($6::payment_status is null or orders.payment_status = $6)
            and ($7::fulfillment_status is null or orders.fulfillment_status = $7)
            and ($8::uuid is null or exists (
              select 1 from order_items where order_id = orders.id and listing_id = $8
            ))
            and ($9::uuid is null or exists (
              select 1 from order_items where order_id = orders.id and fabric_id = $9
            ))
            and (not $10::boolean or orders.payment_status in ('paid', 'partially_refunded', 'refunded'))
            and (not $11::boolean or orders.discount_cents > 0)
            and (not $12::boolean or exists (
              select 1 from refund_operations
              where order_id = orders.id and status = 'succeeded'
            ))
            and (
              $5::order_status is not null
              or $13::text = 'all'
              or ($13 = 'ongoing' and orders.status not in ('completed', 'cancelled'))
              or ($13 = 'completed' and orders.status = 'completed')
              or ($13 = 'cancelled' and orders.status = 'cancelled')
            )
            and (
              $14::timestamptz is null
              or (orders.created_at, orders.id) ${comparator} ($14::timestamptz, $15::uuid)
            )
          order by orders.created_at ${direction}, orders.id ${direction}
          limit $16
        `,
        [
          pattern,
          normalizedPattern,
          query.createdFrom ?? null,
          query.createdTo ?? null,
          query.orderStatus ?? null,
          query.paymentStatus ?? null,
          query.fulfillmentStatus ?? null,
          query.listingId ?? null,
          query.fabricId ?? null,
          query.paidOnly,
          query.discountedOnly,
          query.refundedOnly,
          query.lifecycle,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          query.limit + 1
        ],
      );
      const hasMore = result.rows.length > query.limit;
      const rows = result.rows.slice(0, query.limit);
      const last = rows.at(-1);
      return {
        nextCursor: hasMore && last
          ? encode({ createdAt: iso(last.created_at), id: last.id, sort: query.sort })
          : null,
        orders: rows.map(summary)
      };
    } finally {
      client.release();
    }
  }

  async detail(orderId: string): Promise<AdminOrderDetail> {
    return readOnlyTransaction(this.pool, async (client) => {
      const base = await this.loadOrder(client, orderId);
      if (!base) {
        throw new AdminOrderError("ORDER_NOT_FOUND", "Order not found.", 404);
      }
      const items = await client.query<ItemRow>(
          `select
             order_items.id, order_items.listing_id, order_items.listing_price_variant_id,
             order_items.quantity, order_items.unit_amount_cents,
             order_items.total_amount_cents, order_items.currency,
             order_items.stripe_product_id, order_items.stripe_price_id,
             order_items.listing_snapshot, order_items.fabric_snapshot,
             order_items.customization_snapshot, order_items.customization_asset_id,
             order_items.production_notes, order_items.production_priority_code,
             order_items.production_estimate_snapshot,
             listings.status::text as listing_status,
             fabrics.status::text as fabric_status,
             assets.status as asset_status
           from order_items
           left join listings on listings.id = order_items.listing_id
           left join fabrics on fabrics.id = order_items.fabric_id
           left join assets on assets.id = order_items.customization_asset_id
           where order_items.order_id = $1::uuid
           order by order_items.created_at, order_items.id`,
          [orderId],
        );
      const fulfillments = await client.query(
          `select id, fulfillment_number as "fulfillmentNumber", status,
                  assigned_to_user_id as "assignedToUserId", due_at as "dueAt",
                  ready_to_ship_at as "readyToShipAt", shipped_at as "shippedAt",
                  completed_at as "completedAt", cancelled_at as "cancelledAt",
                  order_snapshot as "orderSnapshot",
                  shipping_name_snapshot as "shippingNameSnapshot",
                  shipping_address_snapshot as "shippingAddressSnapshot",
                  notes, metadata, created_at as "createdAt", updated_at as "updatedAt"
           from order_fulfillments where order_id = $1::uuid
           order by fulfillment_number, id`,
          [orderId],
        );
      const shipments = await client.query(
          `select id, shipment_number as "shipmentNumber", fulfillment_id as "fulfillmentId",
                  status, carrier, carrier_service as "carrierService",
                  tracking_number as "trackingNumber", tracking_url as "trackingUrl",
                  postage_amount_cents as "postageAmountMinor", currency,
                  ship_to_name_snapshot as "shipToNameSnapshot",
                  ship_to_address_snapshot as "shipToAddressSnapshot",
                  shipped_at as "shippedAt", delivered_at as "deliveredAt",
                  completed_at as "completedAt", created_at as "createdAt",
                  updated_at as "updatedAt"
           from shipments where order_id = $1::uuid
           order by shipment_number, id`,
          [orderId],
        );
      return {
        ...summary(base),
        cancelledAt: iso(base.cancelled_at),
        completedAt: iso(base.completed_at),
        contactSnapshot: customer(base),
        fulfillments: fulfillments.rows,
        items: items.rows.map(orderItem),
        paidAt: iso(base.paid_at),
        shipments: shipments.rows,
        shippedAt: iso(base.shipped_at),
        shipping: {
          address: base.shipping_address,
          name: base.shipping_name
        }
      };
    });
  }

  async timeline(
    orderId: string,
    query: AdminOrderTimelineQuery,
  ): Promise<AdminOrderTimelinePage> {
    const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : null;
    const client = await this.pool.connect();
    try {
      const exists = await client.query("select id from orders where id = $1::uuid", [orderId]);
      if (!exists.rows[0]) {
        throw new AdminOrderError("ORDER_NOT_FOUND", "Order not found.", 404);
      }
      const result = await client.query<TimelineRow>(timelineSql, [
        orderId,
        cursor?.occurredAt ?? null,
        cursor?.rank ?? null,
        cursor?.id ?? null,
        query.limit + 1
      ]);
      const hasMore = result.rows.length > query.limit;
      const rows = result.rows.slice(0, query.limit);
      const entries = rows.map((row): AdminOrderTimelineEntry => ({
        actor: {
          displayName: row.actor_display_name,
          id: row.actor_id,
          type: row.actor_type,
          userId: row.actor_user_id
        },
        id: row.id,
        kind: row.kind,
        occurredAt: iso(row.occurred_at)!,
        payload: jsonObject(row.payload),
        visibility: row.visibility
      }));
      const last = rows.at(-1);
      return {
        entries,
        nextCursor: hasMore && last
          ? encode({ id: last.id, occurredAt: iso(last.occurred_at), rank: last.source_rank })
          : null
      };
    } finally {
      client.release();
    }
  }

  private async loadOrder(client: Queryable, orderId: string) {
    const result = await client.query<OrderRow>(
      `select ${orderColumns}
       from orders
       ${orderJoins}
       where orders.id = $1::uuid`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }
}

const timelineSql = `
  with timeline as (
    select
      events.id::text as id,
      events.created_at as occurred_at,
      0 as source_rank,
      'event'::text as kind,
      'internal'::text as visibility,
      events.actor_type::text as actor_type,
      events.actor_id,
      events.actor_user_id::text as actor_user_id,
      users.display_name as actor_display_name,
      jsonb_build_object(
        'eventType', events.event_type,
        'fromValue', events.from_value,
        'toValue', events.to_value,
        'metadata', events.metadata
      ) as payload
    from order_events events
    left join users on users.id = events.actor_user_id
    where events.order_id = $1::uuid
      and events.event_type not in (
        'order_message.queued', 'order_message.sent', 'order_message.failed',
        'order_note.created', 'stripe.refund_transition'
      )

    union all

    select
      messages.id::text,
      messages.created_at,
      1,
      case when messages.direction = 'internal' then 'internal_note' else 'message' end,
      case when messages.direction = 'internal' then 'internal' else 'customer_visible' end,
      messages.sender_type::text,
      messages.sender_user_id,
      messages.sender_authenticated_user_id::text,
      users.display_name,
      jsonb_build_object(
        'channel', messages.channel,
        'direction', messages.direction,
        'status', messages.status,
        'subject', messages.subject,
        'body', messages.body,
        'provider', messages.provider,
        'failureCode', messages.provider_error
      )
    from order_messages messages
    left join users on users.id = messages.sender_authenticated_user_id
    where messages.order_id = $1::uuid

    union all

    select
      refunds.id::text,
      coalesce(refunds.succeeded_at, refunds.failed_at, refunds.created_at),
      2,
      'refund',
      'internal',
      case when refunds.origin = 'kapchi' then 'admin' else 'stripe' end,
      refunds.actor_auth_subject,
      refunds.actor_user_id::text,
      users.display_name,
      jsonb_build_object(
        'amountMinor', refunds.amount_cents,
        'currency', refunds.currency,
        'status', refunds.status,
        'pendingReason', refunds.pending_reason,
        'reasonCode', refunds.reason_code,
        'reasonNote', refunds.reason_note,
        'providerRefundId', refunds.provider_refund_id,
        'failureCode', refunds.provider_failure_code
      )
    from refund_operations refunds
    left join users on users.id = refunds.actor_user_id
    where refunds.order_id = $1::uuid
  )
  select * from timeline
  where $2::timestamptz is null
    or (occurred_at, source_rank, id) > ($2::timestamptz, $3::integer, $4::text)
  order by occurred_at, source_rank, id
  limit $5
`;
