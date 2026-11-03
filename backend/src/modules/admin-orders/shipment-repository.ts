import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AdminOrderError } from "./errors.js";
import { isConfirmedShipmentStatus, isReusableShipmentStatus, prepareShipment } from "./shipment-service.js";
import { confirmedTrackingIdentity } from "./tracking.js";
import type { AdminOrderMutationActor, ConfirmShipmentInput, ConfirmShipmentResult, PaymentStatus } from "./types.js";

type LockedOrder = QueryResultRow & {
  fulfillment_status: string;
  id: string;
  paid_at: Date | string | null;
  payment_status: PaymentStatus;
  revision: number;
  shipped_at: Date | string | null;
  shipping_address: Record<string, unknown> | null;
  shipping_name: string | null;
  status: string;
};

type LockedFulfillment = QueryResultRow & {
  id: string;
  fulfillment_number: number;
  shipping_address_snapshot: Record<string, unknown>;
  shipping_name_snapshot: string | null;
  status: string;
};

type LockedShipment = QueryResultRow & {
  carrier: string | null;
  id: string;
  shipment_number: number;
  status: string;
  tracking_number: string | null;
};

type Receipt = QueryResultRow & {
  request_fingerprint: string;
  result: unknown;
  source_event_id: string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function confirmShipmentFingerprint(orderId: string, input: ConfirmShipmentInput) {
  return sha256(JSON.stringify(canonical({ command: "confirm_shipment", input, orderId })));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateResult(value: unknown): ConfirmShipmentResult {
  if (!isObject(value) || value.command !== "confirm_shipment" || typeof value.orderId !== "string"
    || typeof value.revision !== "number" || typeof value.transitionedAt !== "string"
    || !isObject(value.shipment) || typeof value.shipment.id !== "string"
    || typeof value.shipment.carrier !== "string" || typeof value.shipment.trackingNumber !== "string"
    || typeof value.shipment.shippedAt !== "string") {
    throw new AdminOrderError("ORDER_MUTATION_REPLAY_UNAVAILABLE", "The previous order mutation result is unavailable.", 500);
  }
  return value as ConfirmShipmentResult;
}

function replayReceipt(receipt: Receipt, fingerprint: string) {
  if (receipt.request_fingerprint !== fingerprint) {
    throw new AdminOrderError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different order mutation.", 409);
  }
  return { ...validateResult(receipt.result), replayed: true };
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

export class AdminOrderShipmentRepository {
  constructor(private readonly pool: Pool) {}

  async confirm(
    orderId: string,
    actor: AdminOrderMutationActor,
    rawInput: ConfirmShipmentInput,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<ConfirmShipmentResult> {
    const input = prepareShipment(rawInput);
    return transaction(this.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `admin-order:${orderId}:${sha256(idempotencyKey)}`
      ]);

      const receiptResult = await client.query<Receipt>(
        `select request_fingerprint, result, source_event_id
         from admin_order_mutation_receipts
         where order_id = $1::uuid and idempotency_key = $2
         for update`,
        [orderId, idempotencyKey],
      );
      if (receiptResult.rows[0]) return replayReceipt(receiptResult.rows[0], fingerprint);

      const verifiedActor = await client.query<{ id: string }>(
        `select id from users where id = $1::uuid and auth_provider = 'clerk'
           and auth_subject = $2 and disabled_at is null for share`,
        [actor.userId, actor.authSubject],
      );
      if (!verifiedActor.rows[0]) {
        throw new AdminOrderError("ORDER_ACTOR_UNAVAILABLE", "A verified active administrator profile is required.", 403);
      }

      const orderResult = await client.query<LockedOrder>(
        `select id, status, payment_status, fulfillment_status, paid_at, revision,
                shipped_at, shipping_name, shipping_address
         from orders where id = $1::uuid for update`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order) throw new AdminOrderError("ORDER_NOT_FOUND", "Order not found.", 404);

      const fulfillmentResult = await client.query<LockedFulfillment>(
        `select id, fulfillment_number, status, shipping_name_snapshot, shipping_address_snapshot
         from order_fulfillments where order_id = $1::uuid
         order by fulfillment_number, id for update`,
        [orderId],
      );
      const shipmentResult = await client.query<LockedShipment>(
        `select id, shipment_number, status, carrier, tracking_number
         from shipments where order_id = $1::uuid
         order by shipment_number, id for update`,
        [orderId],
      );
      const primary = fulfillmentResult.rows.find((row) => row.fulfillment_number === 1);
      const confirmed = shipmentResult.rows.find((row) => isConfirmedShipmentStatus(row.status));

      if (confirmed) {
        const same = confirmed.carrier !== null && confirmed.tracking_number !== null
          && confirmedTrackingIdentity(confirmed.carrier, confirmed.tracking_number) === input.trackingIdentity;
        if (same && order.status === "shipped" && order.fulfillment_status === "shipped" && primary?.status === "shipped") {
          const source = await client.query<Receipt>(
            `select request_fingerprint, result, source_event_id
             from admin_order_mutation_receipts
             where order_id = $1::uuid and result->'shipment'->>'id' = $2
             order by created_at, id limit 1 for update`,
            [orderId, confirmed.id],
          );
          if (!source.rows[0]) {
            throw new AdminOrderError("ORDER_MUTATION_REPLAY_UNAVAILABLE", "The previous shipment result is unavailable.", 500);
          }
          const stored = validateResult(source.rows[0].result);
          await client.query(
            `insert into admin_order_mutation_receipts (
               order_id, command, idempotency_key, request_fingerprint, result, source_event_id
             ) values ($1::uuid, 'confirm_shipment', $2, $3, $4::jsonb, $5::uuid)`,
            [orderId, idempotencyKey, fingerprint, JSON.stringify(stored), source.rows[0].source_event_id],
          );
          return { ...stored, replayed: true };
        }
        throw new AdminOrderError("SHIPMENT_ALREADY_CONFIRMED", "A confirmed shipment already exists for this order.", 409);
      }

      if (order.revision !== input.expectedRevision) {
        throw new AdminOrderError("ORDER_REVISION_CONFLICT", "The order changed after it was loaded. Refresh the order and try again.", 409);
      }
      if (order.status !== "ready_to_ship" || order.fulfillment_status !== "ready_to_ship"
        || !primary || primary.status !== "ready_to_ship"
        || (order.payment_status !== "paid" && order.payment_status !== "partially_refunded")
        || order.paid_at === null || !isObject(order.shipping_address)) {
        throw new AdminOrderError("ORDER_TRANSITION_NOT_ALLOWED", "The order is not ready for shipment confirmation.", 409);
      }

      const reusable = shipmentResult.rows.find((row) => isReusableShipmentStatus(row.status));
      if (reusable?.tracking_number
        && (!reusable.carrier
          || confirmedTrackingIdentity(reusable.carrier, reusable.tracking_number) !== input.trackingIdentity)) {
        throw new AdminOrderError("SHIPMENT_ALREADY_CONFIRMED", "The pending shipment contains different tracking details.", 409);
      }

      const shippedAt = new Date().toISOString();
      let shipmentId: string;
      if (reusable) {
        const updated = await client.query<{ id: string }>(
          `update shipments set fulfillment_id = $2::uuid, status = 'in_transit',
             carrier = $3, carrier_service = $4, tracking_number = $5, tracking_url = $6,
             ship_to_name_snapshot = $7, ship_to_address_snapshot = $8::jsonb,
             shipped_at = $9::timestamptz
           where id = $1::uuid returning id`,
          [reusable.id, primary.id, input.carrier, input.carrierService ?? null,
            input.trackingNumber, input.trackingUrl, primary.shipping_name_snapshot,
            JSON.stringify(primary.shipping_address_snapshot), shippedAt],
        );
        shipmentId = updated.rows[0].id;
      } else {
        const shipmentNumber = Math.max(0, ...shipmentResult.rows.map((row) => row.shipment_number)) + 1;
        const inserted = await client.query<{ id: string }>(
          `insert into shipments (
             order_id, fulfillment_id, shipment_number, status, carrier, carrier_service,
             tracking_number, tracking_url, ship_to_name_snapshot,
             ship_to_address_snapshot, shipped_at
           ) values ($1::uuid, $2::uuid, $3, 'in_transit', $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)
           returning id`,
          [orderId, primary.id, shipmentNumber, input.carrier, input.carrierService ?? null,
            input.trackingNumber, input.trackingUrl, primary.shipping_name_snapshot,
            JSON.stringify(primary.shipping_address_snapshot), shippedAt],
        );
        shipmentId = inserted.rows[0].id;
      }

      await client.query(
        `update order_fulfillments set status = 'shipped', shipped_at = $2::timestamptz
         where id = $1::uuid`,
        [primary.id, shippedAt],
      );
      const updatedOrder = await client.query<{ revision: number }>(
        `update orders set status = 'shipped', fulfillment_status = 'shipped',
           shipped_at = $2::timestamptz, revision = revision + 1, updated_at = now()
         where id = $1::uuid and revision = $3 returning revision`,
        [orderId, shippedAt, input.expectedRevision],
      );
      if (!updatedOrder.rows[0]) {
        throw new AdminOrderError("ORDER_REVISION_CONFLICT", "The order changed after it was loaded. Refresh the order and try again.", 409);
      }

      const result: ConfirmShipmentResult = {
        command: "confirm_shipment",
        fulfillmentStatus: "shipped",
        orderId,
        orderStatus: "shipped",
        paymentStatus: order.payment_status as "paid" | "partially_refunded",
        replayed: false,
        revision: updatedOrder.rows[0].revision,
        shipment: {
          carrier: input.carrier,
          carrierService: input.carrierService ?? null,
          id: shipmentId,
          shippedAt,
          trackingNumber: input.trackingNumber,
          trackingUrl: input.trackingUrl
        },
        transitionedAt: shippedAt
      };
      const event = await client.query<{ id: string }>(
        `insert into order_events (
           order_id, actor_type, actor_id, actor_user_id, event_type,
           from_value, to_value, metadata
         ) values ($1::uuid, 'admin', $2, $3::uuid, 'order.shipment_confirmed',
                   'ready_to_ship/ready_to_ship', 'shipped/shipped', $4::jsonb)
         returning id`,
        [orderId, actor.authSubject, actor.userId, JSON.stringify({
          carrier: input.carrier,
          command: "confirm_shipment",
          expectedRevision: input.expectedRevision,
          reason: input.reason ?? null,
          revision: result.revision,
          shipmentId
        })],
      );
      await client.query(
        `insert into admin_order_mutation_receipts (
           order_id, command, idempotency_key, request_fingerprint, result, source_event_id
         ) values ($1::uuid, 'confirm_shipment', $2, $3, $4::jsonb, $5::uuid)`,
        [orderId, idempotencyKey, fingerprint, JSON.stringify(result), event.rows[0].id],
      );
      return result;
    });
  }
}

export type AdminOrderShipmentMutator = Pick<AdminOrderShipmentRepository, "confirm">;
