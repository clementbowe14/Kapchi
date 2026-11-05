import type { QueryResultRow } from "pg";
import {
  FixtureSafetyError,
  fingerprint,
  sha256,
  stableJson,
  type FixtureQueryable
} from "./safety.js";

type OwnedRow = QueryResultRow & {
  canonical_fingerprint: string;
  fixture_key: string;
  immutable: boolean;
  natural_key_hash: string;
  row_id: string;
  table_name: string;
};

export type FixtureOwnership = {
  canonical: unknown;
  fixtureKey: string;
  immutable?: boolean;
  naturalKey: unknown;
  rowId: string;
  tableName: string;
};

export async function assertFixtureOwnership(
  db: FixtureQueryable,
  input: FixtureOwnership,
) {
  const expectedFingerprint = fingerprint(input.canonical);
  const naturalKeyHash = sha256(stableJson(input.naturalKey));
  const ownerResult = await db.query<OwnedRow>(
    `select fixture_key, table_name, row_id, natural_key_hash,
            immutable, canonical_fingerprint
       from kapchi_fixture.owned_rows
      where fixture_key = $1
         or (table_name = $2 and row_id = $3)
         or (table_name = $2 and natural_key_hash = $4)`,
    [input.fixtureKey, input.tableName, input.rowId, naturalKeyHash],
  );
  const owner = ownerResult.rows[0];
  if (!owner) return { expectedFingerprint, naturalKeyHash, owned: false };
  if (
    owner.fixture_key !== input.fixtureKey ||
    owner.table_name !== input.tableName ||
    owner.row_id !== input.rowId ||
    owner.natural_key_hash !== naturalKeyHash
  ) {
    throw new FixtureSafetyError(
      "FIXTURE_OWNERSHIP_COLLISION",
      input.fixtureKey,
      input.tableName,
    );
  }
  if ((input.immutable ?? false) && owner.canonical_fingerprint !== expectedFingerprint) {
    throw new FixtureSafetyError(
      "FIXTURE_IMMUTABLE_DRIFT",
      input.fixtureKey,
      input.tableName,
    );
  }
  return { expectedFingerprint, naturalKeyHash, owned: true };
}

export async function assertNoUnownedCollision(
  db: FixtureQueryable,
  input: FixtureOwnership,
  collisionSql: string,
  values: unknown[],
) {
  const ownership = await assertFixtureOwnership(db, input);
  const collisions = await db.query<{ id: string }>(collisionSql, values);
  const collision = collisions.rows[0];
  if (collision && (!ownership.owned || String(collision.id) !== input.rowId)) {
    throw new FixtureSafetyError(
      "FIXTURE_OWNERSHIP_COLLISION",
      input.fixtureKey,
      input.tableName,
    );
  }
  return ownership;
}

export async function recordFixtureOwnership(
  db: FixtureQueryable,
  input: FixtureOwnership,
) {
  const expectedFingerprint = fingerprint(input.canonical);
  const naturalKeyHash = sha256(stableJson(input.naturalKey));
  await db.query(
    `insert into kapchi_fixture.owned_rows
       (fixture_key, table_name, row_id, natural_key_hash, immutable, canonical_fingerprint)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (fixture_key) do update set
       canonical_fingerprint = excluded.canonical_fingerprint,
       updated_at = now()
     where kapchi_fixture.owned_rows.table_name = excluded.table_name
       and kapchi_fixture.owned_rows.row_id = excluded.row_id
       and kapchi_fixture.owned_rows.natural_key_hash = excluded.natural_key_hash
       and kapchi_fixture.owned_rows.immutable = excluded.immutable`,
    [
      input.fixtureKey,
      input.tableName,
      input.rowId,
      naturalKeyHash,
      input.immutable ?? false,
      expectedFingerprint
    ],
  );
}

export async function upsertOwnedFixture(
  db: FixtureQueryable,
  input: FixtureOwnership & {
    collisionSql: string;
    collisionValues: unknown[];
    write(): Promise<unknown>;
  },
) {
  await assertNoUnownedCollision(
    db,
    input,
    input.collisionSql,
    input.collisionValues,
  );
  await input.write();
  await recordFixtureOwnership(db, input);
}

const dependentFixtureChecks = [
  ["customer_contacts", "customer_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='customers')"],
  ["cart_items", "cart_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='carts')"],
  ["fabric_reservations", "cart_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='carts') or order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_items", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_fulfillments", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_fulfillment_items", "fulfillment_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='order_fulfillments')"],
  ["shipments", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["shipment_items", "shipment_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='shipments')"],
  ["order_events", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_conversations", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_messages", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["message_delivery_jobs", "order_message_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='order_messages')"],
  ["messaging_webhook_events", "order_message_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='order_messages')"],
  ["transactional_notification_intents", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["payment_reconciliation_state", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["refund_operations", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["refund_effects", "refund_operation_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='refund_operations')"],
  ["admin_order_mutation_receipts", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["admin_private_asset_access_events", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["shipping_export_batch_items", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["shipping_export_active_memberships", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["order_policy_assertions", "order_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"],
  ["admin_audit_events", "actor_user_id::text in (select row_id from kapchi_fixture.owned_rows where table_name='users') or target_id in (select row_id from kapchi_fixture.owned_rows where table_name='orders')"]
] as const;

const dependentRowExpressions: Record<string, string | null> = {
  order_policy_assertions: "dependent.order_id::text",
  payment_reconciliation_state: "dependent.order_id::text",
  shipping_export_active_memberships: null
};

export async function assertNoUnownedFixtureDependents(db: FixtureQueryable) {
  for (const [tableName, relationship] of dependentFixtureChecks) {
    const rowExpression = Object.hasOwn(dependentRowExpressions, tableName)
      ? dependentRowExpressions[tableName]
      : "dependent.id::text";
    const result = await db.query<{ count: number | string }>(
      `select count(*) as count from ${tableName} dependent
        where (${relationship})
          ${rowExpression ? `and not exists (
            select 1 from kapchi_fixture.owned_rows owned
             where owned.table_name=$1 and owned.row_id=${rowExpression}
          )` : ""}`,
      rowExpression ? [tableName] : [],
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) {
      throw new FixtureSafetyError(
        "FIXTURE_GRAPH_DIRTY",
        "fixture.graph",
        tableName,
      );
    }
  }
}
