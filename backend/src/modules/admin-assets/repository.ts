import type { Pool, QueryResultRow } from "pg";
import { AdminAssetError } from "./errors.js";
import type {
  AssetDisposition,
  PrivateAssetActor,
  PrivateAssetLookup
} from "./types.js";

type AssetLookupRow = QueryResultRow & {
  asset_byte_size: number | null;
  asset_checksum: string | null;
  asset_content_type: string | null;
  asset_context: string | null;
  asset_expected_pathname: string | null;
  asset_id: string | null;
  asset_original_filename: string | null;
  asset_provider: string | null;
  asset_status: string | null;
  asset_storage_key: string | null;
  asset_visibility: string | null;
  canonical_asset_id: string | null;
  item_id: string | null;
  order_id: string;
  paid_at: Date | string | null;
  snapshot_asset_id: string | null;
};

export type AccessOutcome = "denied" | "failed" | "opened";
export type DeliveryStatus =
  | "aborted"
  | "completed"
  | "failed"
  | "not_started"
  | "streaming";

export interface AdminAssetRepositoryPort {
  findActor(authSubject: string): Promise<PrivateAssetActor | null>;
  lookup(orderId: string, orderItemId: string): Promise<PrivateAssetLookup>;
  recordAccess(input: {
    actor: PrivateAssetActor;
    assetId: string | null;
    deliveryStatus: DeliveryStatus;
    disposition: AssetDisposition;
    orderId: string;
    orderItemId: string;
    outcome: AccessOutcome;
    reasonCode: string | null;
    requestId: string;
  }): Promise<string>;
  updateDelivery(
    eventId: string,
    deliveryStatus: Exclude<DeliveryStatus, "not_started" | "streaming">,
    bytesSent: number,
  ): Promise<void>;
}

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function lookup(row: AssetLookupRow): PrivateAssetLookup {
  return {
    asset: row.asset_id === null
      ? null
      : {
          byteSize: Number(row.asset_byte_size),
          checksum: row.asset_checksum,
          contentType: row.asset_content_type!,
          context: row.asset_context!,
          expectedPathname: row.asset_expected_pathname,
          id: row.asset_id,
          originalFilename: row.asset_original_filename,
          provider: row.asset_provider!,
          status: row.asset_status!,
          storageKey: row.asset_storage_key,
          visibility: row.asset_visibility!
        },
    canonicalAssetId: row.canonical_asset_id,
    orderId: row.order_id,
    orderItemId: row.item_id!,
    paidAt: iso(row.paid_at),
    snapshotAssetId: row.snapshot_asset_id
  };
}

export class AdminAssetRepository implements AdminAssetRepositoryPort {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async findActor(authSubject: string): Promise<PrivateAssetActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `select id
       from users
       where auth_provider = 'clerk'
         and auth_subject = $1
         and disabled_at is null
       limit 1`,
      [authSubject],
    );

    return result.rows[0]
      ? { authSubject, userId: result.rows[0].id }
      : null;
  }

  async lookup(orderId: string, orderItemId: string): Promise<PrivateAssetLookup> {
    const result = await this.pool.query<AssetLookupRow>(
      `select
         orders.id as order_id,
         orders.paid_at,
         order_items.id as item_id,
         order_items.customization_asset_id as canonical_asset_id,
         nullif(order_items.customization_snapshot->>'imageAssetId', '') as snapshot_asset_id,
         assets.id as asset_id,
         assets.provider as asset_provider,
         assets.storage_key as asset_storage_key,
         assets.content_type as asset_content_type,
         assets.byte_size as asset_byte_size,
         assets.checksum as asset_checksum,
         assets.visibility as asset_visibility,
         assets.context as asset_context,
         assets.status as asset_status,
         nullif(assets.metadata->>'expectedPathname', '') as asset_expected_pathname,
         nullif(assets.metadata->>'originalFilename', '') as asset_original_filename
       from orders
       left join order_items
         on order_items.order_id = orders.id
        and order_items.id = $2::uuid
       left join assets on assets.id = order_items.customization_asset_id
       where orders.id = $1::uuid
       limit 1`,
      [orderId, orderItemId],
    );
    const row = result.rows[0];

    if (!row) {
      throw new AdminAssetError("ORDER_NOT_FOUND", "Order not found.", 404);
    }
    if (!row.item_id) {
      throw new AdminAssetError("ORDER_ITEM_NOT_FOUND", "Order item not found.", 404);
    }

    return lookup(row);
  }

  async recordAccess(input: {
    actor: PrivateAssetActor;
    assetId: string | null;
    deliveryStatus: DeliveryStatus;
    disposition: AssetDisposition;
    orderId: string;
    orderItemId: string;
    outcome: AccessOutcome;
    reasonCode: string | null;
    requestId: string;
  }) {
    const result = await this.pool.query<{ id: string }>(
      `insert into admin_private_asset_access_events (
         actor_user_id, actor_auth_subject, order_id, order_item_id, asset_id,
         request_id, disposition, outcome, reason_code, delivery_status
       ) values ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10)
       returning id`,
      [
        input.actor.userId,
        input.actor.authSubject,
        input.orderId,
        input.orderItemId,
        input.assetId,
        input.requestId,
        input.disposition,
        input.outcome,
        input.reasonCode,
        input.deliveryStatus
      ],
    );

    return result.rows[0]!.id;
  }

  async updateDelivery(
    eventId: string,
    deliveryStatus: "aborted" | "completed" | "failed",
    bytesSent: number,
  ) {
    await this.pool.query(
      `update admin_private_asset_access_events
       set delivery_status = $2, bytes_sent = $3
       where id = $1::uuid`,
      [eventId, deliveryStatus, bytesSent],
    );
  }
}
