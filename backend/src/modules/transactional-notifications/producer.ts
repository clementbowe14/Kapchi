import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { deriveTrackingUrl, normalizeCarrier } from "../admin-orders/tracking.js";
import { buildOrderLookupUrl } from "./lookup-url.js";
import { safeItemSummaries } from "./renderers.js";
import { sanitizePlainText, snapshotRecipient } from "./safety.js";
import type {
  NotificationKind,
  Queryable,
  RecipientSnapshot,
  TransactionalNotificationPayload
} from "./types.js";

type OrderSnapshotRow = QueryResultRow & {
  currency: string;
  customer_email: string | null;
  customer_phone: string | null;
  id: string;
  preferred_contact_method: "email" | "sms" | "phone" | null;
  public_order_number: string;
  total_cents: number;
};

type ExistingIntentRow = QueryResultRow & {
  id: string;
  kind: NotificationKind;
  order_id: string;
  payload_hash: string;
  recipient_address: string | null;
  recipient_channel: string | null;
  recipient_failure_code: string | null;
  source_id: string;
  source_type: string;
};

export class NotificationIdempotencyConflictError extends Error {
  readonly code = "MESSAGE_IDEMPOTENCY_CONFLICT";

  constructor() {
    super("A transactional notification idempotency key has conflicting data.");
    this.name = "NotificationIdempotencyConflictError";
  }
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

export function payloadHash(payload: TransactionalNotificationPayload) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
}

async function loadOrderSnapshot(client: Queryable, orderId: string) {
  const result = await client.query<OrderSnapshotRow>(
    `select id, public_order_number, customer_email, customer_phone,
            preferred_contact_method, total_cents, currency
       from orders where id = $1::uuid for share`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("MESSAGE_ORDER_UNAVAILABLE");
  return row;
}

async function loadItemSummary(client: Queryable, orderId: string) {
  const result = await client.query<{ quantity: number; title: unknown }>(
    `select quantity, listing_snapshot ->> 'title' as title
       from order_items
      where order_id = $1::uuid
      order by created_at, id`,
    [orderId],
  );
  const items = safeItemSummaries(result.rows.slice(0, 10));
  return {
    additionalItemCount: Math.max(0, result.rows.length - 10),
    items
  };
}

function recipientFor(row: OrderSnapshotRow) {
  return snapshotRecipient({
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    preferredContactMethod: row.preferred_contact_method
  });
}

export async function ensureTransactionalNotificationIntent(
  client: Queryable,
  input: {
    idempotencyKey: string;
    kind: NotificationKind;
    orderId: string;
    payload: TransactionalNotificationPayload;
    recipient: RecipientSnapshot;
    sourceId: string;
    sourceType: string;
  },
) {
  const hash = payloadHash(input.payload);
  const inserted = await client.query<{ id: string }>(
    `insert into transactional_notification_intents (
       order_id, kind, idempotency_key, source_type, source_id,
       payload_version, payload, payload_hash, recipient_channel,
       recipient_address, recipient_failure_code
     ) values (
       $1::uuid, $2::transactional_notification_kind, $3, $4, $5::uuid,
       1, $6::jsonb, $7, $8::message_channel, $9, $10
     )
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      input.orderId,
      input.kind,
      input.idempotencyKey,
      input.sourceType,
      input.sourceId,
      JSON.stringify(input.payload),
      hash,
      input.recipient.channel,
      input.recipient.address,
      input.recipient.failureCode
    ],
  );
  if (inserted.rows[0]) return { created: true, id: inserted.rows[0].id };

  const existing = await client.query<ExistingIntentRow>(
    `select id, order_id, kind, source_type, source_id, payload_hash,
            recipient_channel, recipient_address, recipient_failure_code
       from transactional_notification_intents
      where idempotency_key = $1 for share`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.order_id !== input.orderId ||
    row.kind !== input.kind ||
    row.source_type !== input.sourceType ||
    row.source_id !== input.sourceId ||
    row.payload_hash !== hash ||
    row.recipient_channel !== input.recipient.channel ||
    row.recipient_address !== input.recipient.address ||
    row.recipient_failure_code !== input.recipient.failureCode
  ) {
    throw new NotificationIdempotencyConflictError();
  }
  return { created: false, id: row.id };
}

export async function ensureOrderConfirmationIntent(
  client: Queryable,
  orderId: string,
  orderLookupBaseUrl: string,
  nodeEnv = "development",
) {
  const order = await loadOrderSnapshot(client, orderId);
  const summary = await loadItemSummary(client, orderId);
  return ensureTransactionalNotificationIntent(client, {
    idempotencyKey: `transactional:order-confirmed:${orderId}`,
    kind: "order.confirmed",
    orderId,
    payload: {
      ...summary,
      currency: order.currency,
      lookupUrl: buildOrderLookupUrl(orderLookupBaseUrl, nodeEnv),
      publicOrderNumber: sanitizePlainText(order.public_order_number, 80),
      totalAmountMinor: order.total_cents
    },
    recipient: recipientFor(order),
    sourceId: orderId,
    sourceType: "order"
  });
}

export async function ensureOrderShipmentIntent(
  client: Queryable,
  orderId: string,
  shipmentId: string,
  orderLookupBaseUrl: string,
  nodeEnv = "development",
) {
  const order = await loadOrderSnapshot(client, orderId);
  const shipment = await client.query<{
    carrier: string | null;
    tracking_number: string | null;
  }>(
    `select carrier, tracking_number from shipments
      where id = $1::uuid and order_id = $2::uuid for share`,
    [shipmentId, orderId],
  );
  const row = shipment.rows[0];
  if (!row) throw new Error("MESSAGE_SHIPMENT_UNAVAILABLE");
  const carrier = sanitizePlainText(row.carrier, 80) || null;
  const trackingNumber = sanitizePlainText(row.tracking_number, 120) || null;
  const trackingUrl = carrier && trackingNumber
    ? deriveTrackingUrl(carrier, trackingNumber)
    : null;

  return ensureTransactionalNotificationIntent(client, {
    idempotencyKey: `transactional:order-shipped:${shipmentId}`,
    kind: "order.shipped",
    orderId,
    payload: {
      carrier: carrier ? normalizeCarrier(carrier) : null,
      lookupUrl: buildOrderLookupUrl(orderLookupBaseUrl, nodeEnv),
      publicOrderNumber: sanitizePlainText(order.public_order_number, 80),
      trackingNumber,
      trackingUrl
    },
    recipient: recipientFor(order),
    sourceId: shipmentId,
    sourceType: "shipment"
  });
}

export async function ensureOrderCancellationIntent(
  client: Queryable,
  orderId: string,
  orderLookupBaseUrl: string,
  nodeEnv = "development",
) {
  const order = await loadOrderSnapshot(client, orderId);
  return ensureTransactionalNotificationIntent(client, {
    idempotencyKey: `transactional:order-cancelled:${orderId}`,
    kind: "order.cancelled",
    orderId,
    payload: {
      lookupUrl: buildOrderLookupUrl(orderLookupBaseUrl, nodeEnv),
      publicOrderNumber: sanitizePlainText(order.public_order_number, 80)
    },
    recipient: recipientFor(order),
    sourceId: orderId,
    sourceType: "order"
  });
}

export async function ensureOrderDeliveryIntent(
  client: Queryable,
  orderId: string,
  shipmentId: string,
  orderLookupBaseUrl: string,
  nodeEnv = "development",
) {
  const order = await loadOrderSnapshot(client, orderId);
  return ensureTransactionalNotificationIntent(client, {
    idempotencyKey: `transactional:order-delivered:${shipmentId}`,
    kind: "order.delivered",
    orderId,
    payload: {
      lookupUrl: buildOrderLookupUrl(orderLookupBaseUrl, nodeEnv),
      publicOrderNumber: sanitizePlainText(order.public_order_number, 80)
    },
    recipient: recipientFor(order),
    sourceId: shipmentId,
    sourceType: "shipment"
  });
}

export async function ensureRefundCompletedIntent(
  client: Queryable,
  input: {
    amountMinor: number;
    currency: string;
    orderId: string;
    refundOperationId: string;
  },
  orderLookupBaseUrl: string,
  nodeEnv = "development",
) {
  const order = await loadOrderSnapshot(client, input.orderId);
  return ensureTransactionalNotificationIntent(client, {
    idempotencyKey: `transactional:refund-completed:${input.refundOperationId}`,
    kind: "refund.completed",
    orderId: input.orderId,
    payload: {
      currency: input.currency,
      lookupUrl: buildOrderLookupUrl(orderLookupBaseUrl, nodeEnv),
      publicOrderNumber: sanitizePlainText(order.public_order_number, 80),
      refundAmountMinor: input.amountMinor
    },
    recipient: recipientFor(order),
    sourceId: input.refundOperationId,
    sourceType: "refund_operation"
  });
}
