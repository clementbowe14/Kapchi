import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { serializeShippingCsv, shippingRowHash } from "./csv.js";
import { ShippingExportError } from "./errors.js";
import {
  normalizePackage,
  normalizePhone,
  normalizeText,
  normalizeUsAddress,
  safeItemTitle,
  safeRoutingText
} from "./normalization.js";
import type {
  AddressCorrectionInput,
  ExportBatchSummary,
  ExportOrderInput,
  ShippingActor,
  ShippingCsvRow
} from "./types.js";

type LockedOrder = QueryResultRow & {
  customer_email: string | null;
  customer_phone: string | null;
  fulfillment_id: string | null;
  fulfillment_record_status: string | null;
  fulfillment_status: string;
  id: string;
  paid_at: Date | string | null;
  payment_status: string;
  public_order_number: string;
  revision: number;
  shipping_address: Record<string, unknown> | null;
  shipping_address_status: string;
  shipping_name: string | null;
  status: string;
};

type ShipmentRow = QueryResultRow & {
  active_shipping_export_batch_id: string | null;
  carrier: string | null;
  id: string;
  label_provider_shipment_id: string | null;
  label_purchased_at: Date | string | null;
  shipment_number: number;
  status: string;
  tracking_number: string | null;
};

type BatchRow = QueryResultRow & {
  created_at: Date | string;
  expires_at: Date | string;
  file_sha256: string;
  file_size_bytes: number;
  id: string;
  issued_count: number;
  mapping_version: number;
  request_fingerprint: string;
  row_count: number;
  status: "prepared" | "cancelled" | "expired";
};

type BatchItemRow = QueryResultRow & {
  order_id: string;
  public_order_number: string;
  row_number: number;
  row_sha256: string;
  row_snapshot: ShippingCsvRow | null;
  shipment_id: string;
};

const confirmedStatuses = new Set([
  "label_purchased",
  "in_transit",
  "delivered",
  "completed"
]);
const reusableStatuses = new Set(["label_pending", "failed"]);

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

export function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function exportFingerprint(rows: ExportOrderInput[]) {
  const normalized = [...rows]
    .map((row) => ({
      expectedRevision: row.expectedRevision,
      orderId: row.orderId,
      package: normalizePackage(row.package)
    }))
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
  return hashValue(JSON.stringify(canonical({ command: "create_shipping_export_v1", rows: normalized })));
}

export function batchMutationFingerprint(
  command: "cancel" | "release",
  batchId: string,
  input: { expectedStatus: string; intent: string; reason: string },
) {
  return hashValue(JSON.stringify(canonical({ batchId, command, input })));
}

export function addressCorrectionFingerprint(orderId: string, input: AddressCorrectionInput) {
  return hashValue(JSON.stringify(canonical({ command: "correct_shipping_address", input, orderId })));
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function filename(batchId: string) {
  return `kapchi-pirate-ship-${batchId}.csv`;
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

function allowedActions(batch: BatchRow, active: boolean) {
  if (!active) return [];
  return batch.status === "prepared"
    ? ["download", "cancel", "confirm_shipment"]
    : batch.status === "expired"
      ? ["release", "confirm_shipment"]
      : [];
}

function summary(
  batch: BatchRow,
  items: BatchItemRow[],
  active: boolean,
): ExportBatchSummary {
  return {
    allowedActions: allowedActions(batch, active),
    createdAt: iso(batch.created_at),
    expiresAt: iso(batch.expires_at),
    filename: filename(batch.id),
    id: batch.id,
    issuedCount: batch.issued_count,
    mappingVersion: 1,
    orders: items.map((item) => ({
      orderId: item.order_id,
      publicOrderNumber: item.public_order_number,
      shipmentId: item.shipment_id
    })),
    rowCount: batch.row_count,
    status: batch.status
  };
}

function batchCreateResult(batch: BatchRow, replayed: boolean, active: boolean) {
  return {
    allowedActions: allowedActions(batch, active),
    batchId: batch.id,
    downloadPath: `/admin/shipping/export-batches/${batch.id}/file`,
    expiresAt: iso(batch.expires_at),
    fileSha256: batch.file_sha256,
    filename: filename(batch.id),
    mappingVersion: 1 as const,
    replayed,
    rowCount: batch.row_count,
    status: batch.status
  };
}

function errorForOrder(code: string, order: LockedOrder, message: string) {
  return new ShippingExportError(code, message, 409, {
    publicOrderNumber: order.public_order_number
  });
}

function titleFromSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "Item";
  const value = snapshot as Record<string, unknown>;
  return safeItemTitle(value.title ?? value.name ?? "Item");
}

function itemSummary(items: Array<{ listing_snapshot: unknown; quantity: number }>) {
  const parts: string[] = [];
  for (const item of items) {
    const part = `${item.quantity} x ${titleFromSnapshot(item.listing_snapshot)}`;
    const candidate = [...parts, part].join("; ");
    if (candidate.length > 500) {
      const truncated = `${parts.join("; ")}; ...`;
      return truncated.slice(0, 500);
    }
    parts.push(part);
  }
  return parts.join("; ");
}

function validateEligibility(
  order: LockedOrder,
  shipments: ShipmentRow[],
  hasMembership: boolean,
  expectedRevision?: number,
) {
  if (expectedRevision !== undefined && order.revision !== expectedRevision) {
    throw errorForOrder("EXPORT_REVISION_STALE", order, "An order changed after it was selected.");
  }
  if (
    order.status !== "ready_to_ship" ||
    order.fulfillment_status !== "ready_to_ship" ||
    order.fulfillment_record_status !== "ready_to_ship" ||
    !order.fulfillment_id ||
    !["paid", "partially_refunded"].includes(order.payment_status) ||
    !order.paid_at
  ) {
    throw errorForOrder("EXPORT_BATCH_INELIGIBLE", order, "An order is not ready to ship.");
  }
  if (order.shipping_address_status !== "valid") {
    throw errorForOrder("EXPORT_ADDRESS_INCOMPLETE", order, "An order has no valid shipping address.");
  }
  normalizeUsAddress(order.shipping_address);
  safeRoutingText(order.shipping_name, "fullName", 100);
  safeRoutingText(order.customer_email, "email", 254);
  if (hasMembership) {
    throw errorForOrder("EXPORT_ALREADY_PREPARED", order, "An order already belongs to an active export.");
  }
  if (shipments.some((shipment) => confirmedStatuses.has(shipment.status) || shipment.tracking_number)) {
    throw errorForOrder("EXPORT_BATCH_INELIGIBLE", order, "An order already has a purchased or confirmed shipment.");
  }
  if (shipments.filter((shipment) => reusableStatuses.has(shipment.status)).length > 1) {
    throw errorForOrder("EXPORT_SHIPMENT_CONFLICT", order, "An order has conflicting pending shipments.");
  }
}

async function findBatchItems(client: PoolClient | Pool, batchId: string) {
  const result = await client.query<BatchItemRow>(
    `select i.order_id, i.shipment_id, i.row_number, i.row_snapshot, i.row_sha256,
            o.public_order_number
     from shipping_export_batch_items i
     join orders o on o.id = i.order_id
     where i.batch_id = $1::uuid
     order by i.row_number`,
    [batchId],
  );
  return result.rows;
}

async function hasActiveMembership(client: PoolClient | Pool, batchId: string) {
  const result = await client.query(
    `select 1 from shipping_export_active_memberships
     where batch_id = $1::uuid limit 1`,
    [batchId],
  );
  return result.rows.length > 0;
}

export class ShippingExportRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(authSubject: string): Promise<ShippingActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `select id from users
       where auth_provider = 'clerk' and auth_subject = $1 and disabled_at is null`,
      [authSubject],
    );
    return result.rows[0] ? { authSubject, userId: result.rows[0].id } : null;
  }

  async preflight(orderIds: string[]) {
    const uniqueIds = [...new Set(orderIds)].sort();
    const orders = await this.pool.query<LockedOrder>(
      `select o.id, o.public_order_number, o.status, o.payment_status,
              o.fulfillment_status, o.paid_at, o.revision, o.customer_email,
              o.customer_phone, o.shipping_name, o.shipping_address,
              o.shipping_address_status, f.id as fulfillment_id,
              f.status as fulfillment_record_status
       from orders o
       left join order_fulfillments f
         on f.order_id = o.id and f.fulfillment_number = 1
       where o.id = any($1::uuid[])
       order by o.id`,
      [uniqueIds],
    );
    const shipments = await this.pool.query<ShipmentRow & {
      package_height_inches: string | null;
      package_length_inches: string | null;
      package_weight_ounces: string | null;
      package_width_inches: string | null;
    }>(
      `select id, order_id, shipment_number, status, carrier, tracking_number,
              label_provider_shipment_id, label_purchased_at,
              active_shipping_export_batch_id, package_weight_ounces,
              package_length_inches, package_width_inches, package_height_inches
       from shipments where order_id = any($1::uuid[])
       order by order_id, shipment_number, id`,
      [uniqueIds],
    );
    const memberships = await this.pool.query<{ order_id: string }>(
      `select order_id from shipping_export_active_memberships
       where order_id = any($1::uuid[])`,
      [uniqueIds],
    );
    const membershipSet = new Set(memberships.rows.map((row) => row.order_id));
    const orderMap = new Map(orders.rows.map((order) => [order.id, order]));
    return {
      candidates: orderIds.map((orderId) => {
        const order = orderMap.get(orderId);
        if (!order) return { codes: ["EXPORT_BATCH_NOT_FOUND"], eligible: false, orderId };
        const orderShipments = shipments.rows.filter((row) => row.order_id === orderId);
        try {
          validateEligibility(order, orderShipments, membershipSet.has(orderId));
          const reusable = orderShipments.find((row) => reusableStatuses.has(row.status));
          return {
            codes: [],
            eligible: true,
            existingPackage: reusable ? {
              heightInches: reusable.package_height_inches,
              lengthInches: reusable.package_length_inches,
              weightOunces: reusable.package_weight_ounces,
              widthInches: reusable.package_width_inches
            } : null,
            orderId,
            publicOrderNumber: order.public_order_number,
            revision: order.revision
          };
        } catch (error) {
          const code = error instanceof ShippingExportError ? error.code : "EXPORT_BATCH_INELIGIBLE";
          return {
            codes: [code],
            eligible: false,
            orderId,
            publicOrderNumber: order.public_order_number,
            revision: order.revision
          };
        }
      })
    };
  }

  async createBatch(
    actor: ShippingActor,
    rawRows: ExportOrderInput[],
    idempotencyKey: string,
    fingerprint: string,
    requestId: string,
  ) {
    const rows = [...rawRows].sort((left, right) => left.orderId.localeCompare(right.orderId));
    const keyHash = hashValue(idempotencyKey);
    return transaction(this.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `shipping-export:pirate_ship:${keyHash}`
      ]);
      const existing = await client.query<BatchRow>(
        `select * from shipping_export_batches
         where provider = 'pirate_ship' and idempotency_key_hash = $1 for update`,
        [keyHash],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fingerprint) {
          throw new ShippingExportError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was used for a different shipping export.",
            409,
          );
        }
        return batchCreateResult(
          existing.rows[0],
          true,
          await hasActiveMembership(client, existing.rows[0].id),
        );
      }
      const verifiedActor = await client.query(
        `select id from users where id = $1::uuid and auth_provider = 'clerk'
         and auth_subject = $2 and disabled_at is null for share`,
        [actor.userId, actor.authSubject],
      );
      if (!verifiedActor.rows[0]) {
        throw new ShippingExportError(
          "ORDER_ACTOR_UNAVAILABLE",
          "A verified active administrator profile is required.",
          403,
        );
      }
      const orderIds = rows.map((row) => row.orderId);
      const orders = await client.query<LockedOrder>(
        `select o.id, o.public_order_number, o.status, o.payment_status,
                o.fulfillment_status, o.paid_at, o.revision, o.customer_email,
                o.customer_phone, o.shipping_name, o.shipping_address,
                o.shipping_address_status, null::uuid as fulfillment_id,
                null::text as fulfillment_record_status
         from orders o where o.id = any($1::uuid[])
         order by o.id for update`,
        [orderIds],
      );
      if (orders.rows.length !== rows.length) {
        throw new ShippingExportError("EXPORT_BATCH_NOT_FOUND", "One or more orders were not found.", 404);
      }
      const fulfillmentResult = await client.query<{
        id: string;
        order_id: string;
        status: string;
      }>(
        `select id, order_id, status from order_fulfillments
         where order_id = any($1::uuid[]) and fulfillment_number = 1
         order by order_id, fulfillment_number, id for update`,
        [orderIds],
      );
      for (const order of orders.rows) {
        const fulfillment = fulfillmentResult.rows.find((row) => row.order_id === order.id);
        order.fulfillment_id = fulfillment?.id ?? null;
        order.fulfillment_record_status = fulfillment?.status ?? null;
      }
      const shipmentResult = await client.query<ShipmentRow & { order_id: string }>(
        `select id, order_id, shipment_number, status, carrier, tracking_number,
                label_provider_shipment_id, label_purchased_at,
                active_shipping_export_batch_id
         from shipments where order_id = any($1::uuid[])
         order by order_id, shipment_number, id for update`,
        [orderIds],
      );
      const memberships = await client.query<{ order_id: string }>(
        `select order_id from shipping_export_active_memberships
         where order_id = any($1::uuid[]) order by order_id for update`,
        [orderIds],
      );
      const membershipSet = new Set(memberships.rows.map((row) => row.order_id));
      const orderMap = new Map(orders.rows.map((order) => [order.id, order]));
      const inputMap = new Map(rows.map((row) => [row.orderId, row]));
      for (const orderId of orderIds) {
        const order = orderMap.get(orderId)!;
        validateEligibility(
          order,
          shipmentResult.rows.filter((shipment) => shipment.order_id === orderId),
          membershipSet.has(orderId),
          inputMap.get(orderId)!.expectedRevision,
        );
      }
      const itemResult = await client.query<{
        listing_snapshot: unknown;
        order_id: string;
        quantity: number;
      }>(
        `select order_id, quantity, listing_snapshot from order_items
         where order_id = any($1::uuid[])
         order by order_id, created_at, id`,
        [orderIds],
      );
      const batchId = randomUUID();
      const prepared: Array<{
        csv: ShippingCsvRow;
        order: LockedOrder;
        package: ReturnType<typeof normalizePackage>;
        resetFailed: boolean;
        shipmentId: string;
        shipmentNumber: number;
        tokenHash: string;
      }> = [];
      for (const orderId of orderIds) {
        const order = orderMap.get(orderId)!;
        const orderShipments = shipmentResult.rows.filter((row) => row.order_id === orderId);
        const reusable = orderShipments.find((row) => reusableStatuses.has(row.status));
        const shipmentId = reusable?.id ?? randomUUID();
        const shipmentNumber = reusable?.shipment_number ??
          Math.max(0, ...orderShipments.map((row) => row.shipment_number)) + 1;
        const packageInput = normalizePackage(inputMap.get(orderId)!.package);
        const address = normalizeUsAddress(order.shipping_address);
        const token = `KPS1-${randomBytes(18).toString("base64url")}`;
        const items = itemResult.rows.filter((item) => item.order_id === orderId);
        const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
        const csv: ShippingCsvRow = {
          addressLine1: address.line1,
          addressLine2: address.line2 ?? "",
          city: address.city,
          company: "",
          country: address.country,
          email: safeRoutingText(order.customer_email, "email", 254),
          fullName: safeRoutingText(order.shipping_name, "fullName", 100),
          height: packageInput.heightInches,
          kapchiReference: token,
          length: packageInput.lengthInches,
          note: "Kapchi shipping export v1",
          orderId: safeRoutingText(order.public_order_number, "orderId", 64),
          orderItemCount: String(totalItems),
          orderItems: itemSummary(items),
          phone: normalizePhone(order.customer_phone),
          state: address.state,
          weightOunces: packageInput.weightOunces,
          width: packageInput.widthInches,
          zip: address.postalCode
        };
        prepared.push({
          csv,
          order,
          package: packageInput,
          resetFailed: reusable?.status === "failed",
          shipmentId,
          shipmentNumber,
          tokenHash: hashValue(token)
        });
      }
      const file = serializeShippingCsv(prepared.map((row) => row.csv));
      const batchInsert = await client.query<BatchRow>(
        `insert into shipping_export_batches (
           id, actor_user_id, actor_auth_subject, request_id,
           idempotency_key_hash, request_fingerprint, row_count,
           file_sha256, file_size_bytes
         ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [batchId, actor.userId, actor.authSubject, requestId, keyHash,
          fingerprint, prepared.length, file.sha256, file.bytes.byteLength],
      );
      for (const [index, row] of prepared.entries()) {
        const existing = shipmentResult.rows.find((shipment) => shipment.id === row.shipmentId);
        if (existing) {
          await client.query(
            `update shipments set fulfillment_id = $2::uuid, status = 'label_pending',
               package_weight_ounces = $3::numeric,
               package_length_inches = $4::numeric,
               package_width_inches = $5::numeric,
               package_height_inches = $6::numeric,
               package_description = $7,
               ship_to_name_snapshot = $8, ship_to_address_snapshot = $9::jsonb,
               active_shipping_export_batch_id = $10::uuid, exported_at = now(),
               carrier = case when $11 then null else carrier end,
               carrier_service = case when $11 then null else carrier_service end,
               tracking_number = case when $11 then null else tracking_number end,
               tracking_url = case when $11 then null else tracking_url end,
               label_provider = case when $11 then null else label_provider end,
               label_provider_shipment_id = case when $11 then null else label_provider_shipment_id end,
               label_url = case when $11 then null else label_url end,
               label_file_object_key = case when $11 then null else label_file_object_key end,
               label_purchased_at = case when $11 then null else label_purchased_at end,
               label_voided_at = case when $11 then null else label_voided_at end,
               postage_amount_cents = case when $11 then null else postage_amount_cents end,
               imported_at = case when $11 then null else imported_at end,
               label_metadata = case when $11 then '{}'::jsonb else label_metadata end
             where id = $1::uuid`,
            [row.shipmentId, row.order.fulfillment_id, row.package.weightOunces,
              row.package.lengthInches, row.package.widthInches, row.package.heightInches,
              row.package.description, row.order.shipping_name,
              JSON.stringify(row.order.shipping_address), batchId, row.resetFailed],
          );
        } else {
          await client.query(
            `insert into shipments (
               id, order_id, fulfillment_id, shipment_number, status,
               package_weight_ounces, package_length_inches, package_width_inches,
               package_height_inches, package_description, ship_to_name_snapshot,
               ship_to_address_snapshot, active_shipping_export_batch_id, exported_at
             ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'label_pending',
                       $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9,
                       $10, $11::jsonb, $12::uuid, now())`,
            [row.shipmentId, row.order.id, row.order.fulfillment_id,
              row.shipmentNumber, row.package.weightOunces, row.package.lengthInches,
              row.package.widthInches, row.package.heightInches, row.package.description,
              row.order.shipping_name, JSON.stringify(row.order.shipping_address), batchId],
          );
        }
        await client.query(
          `insert into shipping_export_batch_items (
             batch_id, order_id, shipment_id, row_number, row_snapshot,
             row_sha256, reconciliation_token_hash
           ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7)`,
          [batchId, row.order.id, row.shipmentId, index + 1,
            JSON.stringify(row.csv), shippingRowHash(row.csv), row.tokenHash],
        );
        await client.query(
          `insert into shipping_export_active_memberships (order_id, shipment_id, batch_id)
           values ($1::uuid, $2::uuid, $3::uuid)`,
          [row.order.id, row.shipmentId, batchId],
        );
        await client.query(
          `insert into order_events (
             order_id, actor_type, actor_id, actor_user_id, event_type, metadata
           ) values ($1::uuid, 'admin', $2, $3::uuid, 'order.shipping_exported', $4::jsonb)`,
          [row.order.id, actor.authSubject, actor.userId,
            JSON.stringify({
              batchId,
              mappingVersion: 1,
              resetFailedShipment: row.resetFailed,
              shipmentId: row.shipmentId
            })],
        );
      }
      await client.query(
        `insert into admin_audit_events (
           actor_user_id, actor_auth_subject, capability, action,
           target_type, target_id, request_id, idempotency_key, metadata
         ) values ($1::uuid, $2, 'fulfillment:write', 'shipping_export.create',
                   'shipping_export_batch', $3, $4, $5, $6::jsonb)`,
        [actor.userId, actor.authSubject, batchId, requestId,
          `shipping-export:${keyHash}`, JSON.stringify({ mappingVersion: 1, rowCount: prepared.length })],
      );
      return batchCreateResult(batchInsert.rows[0], false, true);
    });
  }

  async list(statuses: string[], cursor: string | undefined, limit: number) {
    const values: unknown[] = [statuses, limit + 1];
    const cursorClause = cursor
      ? (values.push(cursor), `and (b.created_at, b.id) < (
          select created_at, id from shipping_export_batches where id = $3::uuid
        )`)
      : "";
    const result = await this.pool.query<BatchRow>(
      `select b.* from shipping_export_batches b
       where b.status = any($1::text[])
         and exists (
           select 1 from shipping_export_active_memberships memberships
           where memberships.batch_id = b.id
         )
         ${cursorClause}
       order by b.created_at desc, b.id desc limit $2`,
      values,
    );
    const page = result.rows.slice(0, limit);
    const batches = await Promise.all(page.map(async (batch) =>
      summary(batch, await findBatchItems(this.pool, batch.id), true)));
    return {
      batches,
      nextCursor: result.rows.length > limit ? page.at(-1)!.id : null
    };
  }

  async detail(batchId: string) {
    const batch = await this.pool.query<BatchRow>(
      `select * from shipping_export_batches where id = $1::uuid`,
      [batchId],
    );
    if (!batch.rows[0]) {
      throw new ShippingExportError("EXPORT_BATCH_NOT_FOUND", "Shipping export batch not found.", 404);
    }
    return summary(
      batch.rows[0],
      await findBatchItems(this.pool, batchId),
      await hasActiveMembership(this.pool, batchId),
    );
  }

  async download(batchId: string) {
    return transaction(this.pool, async (client) => {
      const batch = await client.query<BatchRow>(
        `select * from shipping_export_batches where id = $1::uuid for update`,
        [batchId],
      );
      const current = batch.rows[0];
      if (!current) {
        throw new ShippingExportError("EXPORT_BATCH_NOT_FOUND", "Shipping export batch not found.", 404);
      }
      if (current.status === "cancelled") {
        throw new ShippingExportError("EXPORT_BATCH_INACTIVE", "This shipping export is no longer active.", 410);
      }
      if (current.status === "expired" || new Date(current.expires_at) <= new Date()) {
        throw new ShippingExportError("EXPORT_BATCH_EXPIRED", "This shipping export has expired.", 410);
      }
      const items = await findBatchItems(client, batchId);
      if (items.some((item) => item.row_snapshot === null)) {
        throw new ShippingExportError("EXPORT_BATCH_EXPIRED", "This shipping export has expired.", 410);
      }
      if (items.some((item) => shippingRowHash(item.row_snapshot!) !== item.row_sha256)) {
        throw new ShippingExportError(
          "SHIPPING_EXPORT_UNAVAILABLE",
          "The shipping export could not be verified.",
          503,
        );
      }
      const file = serializeShippingCsv(items.map((item) => item.row_snapshot!));
      if (file.sha256 !== current.file_sha256 || file.bytes.byteLength !== current.file_size_bytes) {
        throw new ShippingExportError(
          "SHIPPING_EXPORT_UNAVAILABLE",
          "The shipping export could not be verified.",
          503,
        );
      }
      await client.query(
        `update shipping_export_batches set issued_count = issued_count + 1,
           first_issued_at = coalesce(first_issued_at, now()), last_issued_at = now()
         where id = $1::uuid`,
        [batchId],
      );
      return { bytes: file.bytes, filename: filename(batchId), sha256: file.sha256 };
    });
  }

  async mutateBatch(
    command: "cancel" | "release",
    batchId: string,
    actor: ShippingActor,
    input: { expectedStatus: "prepared" | "expired"; intent: "no_label_purchased"; reason: string },
    idempotencyKey: string,
    fingerprint: string,
    requestId: string,
  ) {
    return transaction(this.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `shipping-export:${batchId}:${command}:${hashValue(idempotencyKey)}`
      ]);
      const receipt = await client.query<{ request_fingerprint: string; result: unknown }>(
        `select request_fingerprint, result from shipping_export_mutation_receipts
         where batch_id = $1::uuid and command = $2 and idempotency_key = $3 for update`,
        [batchId, command, idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== fingerprint) {
          throw new ShippingExportError("IDEMPOTENCY_CONFLICT", "This key was used for a different command.", 409);
        }
        return { ...(receipt.rows[0].result as Record<string, unknown>), replayed: true };
      }
      const verified = await client.query(
        `select id from users where id = $1::uuid and auth_subject = $2
         and auth_provider = 'clerk' and disabled_at is null for share`,
        [actor.userId, actor.authSubject],
      );
      if (!verified.rows[0]) {
        throw new ShippingExportError("ORDER_ACTOR_UNAVAILABLE", "A verified active administrator is required.", 403);
      }
      const ids = await client.query<{ order_id: string; shipment_id: string }>(
        `select order_id, shipment_id from shipping_export_batch_items
         where batch_id = $1::uuid order by order_id`,
        [batchId],
      );
      const orderIds = ids.rows.map((row) => row.order_id);
      const shipmentIds = ids.rows.map((row) => row.shipment_id);
      if (orderIds.length) {
        await client.query(`select id from orders where id = any($1::uuid[]) order by id for update`, [orderIds]);
        await client.query(`select id from order_fulfillments where order_id = any($1::uuid[]) order by order_id, fulfillment_number, id for update`, [orderIds]);
        await client.query(`select id from shipments where id = any($1::uuid[]) order by order_id, shipment_number, id for update`, [shipmentIds]);
        await client.query(`select order_id from shipping_export_active_memberships where order_id = any($1::uuid[]) order by order_id for update`, [orderIds]);
      }
      const batch = await client.query<BatchRow>(
        `select * from shipping_export_batches where id = $1::uuid for update`,
        [batchId],
      );
      if (!batch.rows[0]) {
        throw new ShippingExportError("EXPORT_BATCH_NOT_FOUND", "Shipping export batch not found.", 404);
      }
      const requiredStatus = command === "cancel" ? "prepared" : "expired";
      if (input.expectedStatus !== requiredStatus || batch.rows[0].status !== requiredStatus) {
        throw new ShippingExportError("EXPORT_BATCH_INELIGIBLE", "The shipping export cannot perform this action.", 409);
      }
      const membershipCount = await client.query<{ count: number }>(
        `select count(*)::integer as count from shipping_export_active_memberships
         where batch_id = $1::uuid`,
        [batchId],
      );
      if (membershipCount.rows[0].count !== orderIds.length) {
        throw new ShippingExportError("EXPORT_BATCH_INELIGIBLE", "The shipping export is no longer active.", 409);
      }
      const unsafe = await client.query(
        `select id from shipments where id = any($1::uuid[])
         and (tracking_number is not null or label_purchased_at is not null
              or label_provider_shipment_id is not null
              or status in ('label_purchased','in_transit','delivered','completed')) limit 1`,
        [shipmentIds],
      );
      if (unsafe.rows[0]) {
        throw new ShippingExportError("EXPORT_BATCH_INELIGIBLE", "A purchased or confirmed shipment cannot be released.", 409);
      }
      if (command === "cancel") {
        await client.query(
          `update shipping_export_batches set status = 'cancelled', cancelled_at = now()
           where id = $1::uuid`,
          [batchId],
        );
      }
      await client.query(`delete from shipping_export_active_memberships where batch_id = $1::uuid`, [batchId]);
      await client.query(
        `update shipments set active_shipping_export_batch_id = null
         where id = any($1::uuid[]) and active_shipping_export_batch_id = $2::uuid`,
        [shipmentIds, batchId],
      );
      const eventType = command === "cancel"
        ? "order.shipping_export_cancelled"
        : "order.shipping_export_released";
      for (const row of ids.rows) {
        await client.query(
          `insert into order_events (
             order_id, actor_type, actor_id, actor_user_id, event_type, metadata
           ) values ($1::uuid, 'admin', $2, $3::uuid, $4, $5::jsonb)`,
          [row.order_id, actor.authSubject, actor.userId, eventType,
            JSON.stringify({ batchId, reason: normalizeText(input.reason), shipmentId: row.shipment_id })],
        );
      }
      const audit = await client.query<{ id: string }>(
        `insert into admin_audit_events (
           actor_user_id, actor_auth_subject, capability, action, target_type,
           target_id, request_id, idempotency_key, metadata
         ) values ($1::uuid, $2, 'fulfillment:write', $3, 'shipping_export_batch',
                   $4, $5, $6, $7::jsonb) returning id`,
        [actor.userId, actor.authSubject, `shipping_export.${command}`, batchId,
          requestId, `shipping-export-${command}:${batchId}:${hashValue(idempotencyKey)}`,
          JSON.stringify({ rowCount: orderIds.length })],
      );
      const result = {
        batchId,
        command,
        replayed: false,
        status: command === "cancel" ? "cancelled" : "expired"
      };
      await client.query(
        `insert into shipping_export_mutation_receipts (
           batch_id, command, idempotency_key, request_fingerprint, result,
           source_audit_event_id
         ) values ($1::uuid, $2, $3, $4, $5::jsonb, $6::uuid)`,
        [batchId, command, idempotencyKey, fingerprint, JSON.stringify(result), audit.rows[0].id],
      );
      return result;
    });
  }

  async correctAddress(
    orderId: string,
    actor: ShippingActor,
    rawInput: AddressCorrectionInput,
    idempotencyKey: string,
    fingerprint: string,
  ) {
    const address = normalizeUsAddress(rawInput.address);
    const name = safeRoutingText(rawInput.name, "name", 100);
    const reason = normalizeText(rawInput.reason);
    return transaction(this.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `admin-order:${orderId}:${hashValue(idempotencyKey)}`
      ]);
      const receipt = await client.query<{ request_fingerprint: string; result: unknown }>(
        `select request_fingerprint, result from admin_order_mutation_receipts
         where order_id = $1::uuid and idempotency_key = $2 for update`,
        [orderId, idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].request_fingerprint !== fingerprint) {
          throw new ShippingExportError("IDEMPOTENCY_CONFLICT", "This key was used for another order mutation.", 409);
        }
        return { ...(receipt.rows[0].result as Record<string, unknown>), replayed: true };
      }
      const verified = await client.query(
        `select id from users where id = $1::uuid and auth_subject = $2
         and auth_provider = 'clerk' and disabled_at is null for share`,
        [actor.userId, actor.authSubject],
      );
      if (!verified.rows[0]) {
        throw new ShippingExportError("ORDER_ACTOR_UNAVAILABLE", "A verified active administrator is required.", 403);
      }
      const orderResult = await client.query<LockedOrder>(
        `select id, public_order_number, status, payment_status, fulfillment_status,
                paid_at, revision, customer_email, customer_phone, shipping_name,
                shipping_address, shipping_address_status, null::uuid as fulfillment_id,
                null::text as fulfillment_record_status
         from orders where id = $1::uuid for update`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order) throw new ShippingExportError("EXPORT_BATCH_NOT_FOUND", "Order not found.", 404);
      const fulfillments = await client.query<{ id: string; status: string }>(
        `select id, status from order_fulfillments where order_id = $1::uuid
         order by fulfillment_number, id for update`,
        [orderId],
      );
      const shipments = await client.query<ShipmentRow>(
        `select id, shipment_number, status, carrier, tracking_number,
                label_provider_shipment_id, label_purchased_at,
                active_shipping_export_batch_id
         from shipments where order_id = $1::uuid order by shipment_number, id for update`,
        [orderId],
      );
      const membership = await client.query(
        `select order_id from shipping_export_active_memberships
         where order_id = $1::uuid for update`,
        [orderId],
      );
      if (order.revision !== rawInput.expectedRevision) {
        throw new ShippingExportError("EXPORT_REVISION_STALE", "The order changed after it was loaded.", 409);
      }
      if (
        !["paid", "in_production", "ready_to_ship"].includes(order.status) ||
        !["paid", "partially_refunded"].includes(order.payment_status) ||
        !["not_started", "queued", "in_progress", "ready_to_ship"].includes(order.fulfillment_status) ||
        fulfillments.rows.some((row) => !["queued", "in_progress", "ready_to_ship"].includes(row.status)) ||
        membership.rows.length > 0 ||
        shipments.rows.some((row) => confirmedStatuses.has(row.status) || row.tracking_number ||
          row.label_purchased_at || row.label_provider_shipment_id)
      ) {
        throw new ShippingExportError("EXPORT_BATCH_INELIGIBLE", "The shipping address cannot be changed in the current state.", 409);
      }
      const beforeHash = hashValue(JSON.stringify(canonical({
        address: order.shipping_address,
        name: order.shipping_name
      })));
      const afterHash = hashValue(JSON.stringify(canonical({ address, name })));
      const updated = await client.query<{ revision: number }>(
        `update orders set shipping_name = $2, shipping_address = $3::jsonb,
           shipping_address_status = 'valid', shipping_address_issue_code = null,
           revision = revision + 1, updated_at = now()
         where id = $1::uuid and revision = $4 returning revision`,
        [orderId, name, JSON.stringify(address), rawInput.expectedRevision],
      );
      if (!updated.rows[0]) {
        throw new ShippingExportError("EXPORT_REVISION_STALE", "The order changed after it was loaded.", 409);
      }
      await client.query(
        `update order_fulfillments set shipping_name_snapshot = $2,
           shipping_address_snapshot = $3::jsonb where order_id = $1::uuid`,
        [orderId, name, JSON.stringify(address)],
      );
      await client.query(
        `update shipments set ship_to_name_snapshot = $2,
           ship_to_address_snapshot = $3::jsonb
         where order_id = $1::uuid and status in ('label_pending','failed')
           and tracking_number is null and label_purchased_at is null`,
        [orderId, name, JSON.stringify(address)],
      );
      const transitionedAt = new Date().toISOString();
      const result = {
        command: "correct_shipping_address",
        orderId,
        replayed: false,
        revision: updated.rows[0].revision,
        shippingAddressStatus: "valid",
        transitionedAt
      };
      const event = await client.query<{ id: string }>(
        `insert into order_events (
           order_id, actor_type, actor_id, actor_user_id, event_type, metadata
         ) values ($1::uuid, 'admin', $2, $3::uuid, 'order.shipping_address_corrected', $4::jsonb)
         returning id`,
        [orderId, actor.authSubject, actor.userId,
          JSON.stringify({ afterHash, beforeHash, reason, revision: updated.rows[0].revision })],
      );
      await client.query(
        `insert into admin_order_mutation_receipts (
           order_id, command, idempotency_key, request_fingerprint, result, source_event_id
         ) values ($1::uuid, 'correct_shipping_address', $2, $3, $4::jsonb, $5::uuid)`,
        [orderId, idempotencyKey, fingerprint, JSON.stringify(result), event.rows[0].id],
      );
      return result;
    });
  }

  async purgeExpired(limit = 100) {
    return transaction(this.pool, async (client) => {
      const batches = await client.query<{ id: string }>(
        `select id from shipping_export_batches
         where status in ('prepared', 'cancelled') and purged_at is null
           and expires_at <= now()
         order by expires_at, id for update skip locked limit $1`,
        [limit],
      );
      const ids = batches.rows.map((row) => row.id);
      if (ids.length === 0) return { purged: 0 };
      await client.query(
        `update shipping_export_batch_items set row_snapshot = null
         where batch_id = any($1::uuid[])`,
        [ids],
      );
      await client.query(
        `update shipping_export_batches
         set status = case when status = 'prepared' then 'expired' else status end,
             purged_at = now()
         where id = any($1::uuid[])`,
        [ids],
      );
      return { purged: ids.length };
    });
  }
}

export type ShippingExportRepositoryPort = Pick<
  ShippingExportRepository,
  "correctAddress" | "createBatch" | "detail" | "download" | "list" |
  "mutateBatch" | "preflight" | "purgeExpired" | "resolveActor"
>;
