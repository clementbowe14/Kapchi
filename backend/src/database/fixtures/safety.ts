import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  FIXTURE_ADVISORY_LOCK_KEY,
  FIXTURE_MARKER_ID,
  FIXTURE_NAMESPACE
} from "./admin-workflows.js";

export type FixtureQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type FixtureErrorCode =
  | "FIXTURE_DATABASE_ALREADY_INITIALIZED"
  | "FIXTURE_DATABASE_CONFIRMATION_MISMATCH"
  | "FIXTURE_DATABASE_MARKER_MISSING"
  | "FIXTURE_DATABASE_MARKER_MISMATCH"
  | "FIXTURE_DATABASE_NAME_UNSAFE"
  | "FIXTURE_DATABASE_REMOTE"
  | "FIXTURE_DATABASE_TOKEN_MISSING"
  | "FIXTURE_DATABASE_TOKEN_MISMATCH"
  | "FIXTURE_DATABASE_URL_INVALID"
  | "FIXTURE_DATABASE_URL_MISSING"
  | "FIXTURE_NODE_ENV_UNSAFE"
  | "FIXTURE_OWNERSHIP_COLLISION"
  | "FIXTURE_DEPENDENCY_DRIFT"
  | "FIXTURE_GRAPH_DIRTY"
  | "FIXTURE_IMMUTABLE_DRIFT"
  | "FIXTURE_VERIFICATION_FAILED";

export class FixtureSafetyError extends Error {
  constructor(
    readonly code: FixtureErrorCode,
    readonly fixtureKey?: string,
    readonly tableAlias?: string,
  ) {
    super(fixtureErrorMessage(code));
    this.name = "FixtureSafetyError";
  }
}

function fixtureErrorMessage(code: FixtureErrorCode) {
  if (code === "FIXTURE_NODE_ENV_UNSAFE") {
    return "Refusing fixture access when NODE_ENV=production or is otherwise unsafe.";
  }
  if (code === "FIXTURE_DATABASE_REMOTE") {
    return "Refusing fixture access to a non-local database host.";
  }
  return code;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown) {
  return sha256(stableJson(value));
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function parseSafeFixtureTarget(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV ?? "development",
) {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new FixtureSafetyError("FIXTURE_NODE_ENV_UNSAFE");
  }
  if (!databaseUrl) throw new FixtureSafetyError("FIXTURE_DATABASE_URL_MISSING");

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new FixtureSafetyError("FIXTURE_DATABASE_URL_INVALID");
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_URL_INVALID");
  }
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_REMOTE");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(?:^|_)(?:dev|test|local)(?:_|$)/i.test(databaseName)) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_NAME_UNSAFE");
  }
  return { databaseName, parsed };
}

type DatabaseIdentityRow = QueryResultRow & {
  database_name: string;
  database_oid: number | string;
};

async function currentDatabaseIdentity(db: FixtureQueryable) {
  const result = await db.query<DatabaseIdentityRow>(
    `select current_database() as database_name,
            (select oid::text from pg_database where datname = current_database()) as database_oid`,
  );
  const row = result.rows[0];
  if (!row) throw new FixtureSafetyError("FIXTURE_DATABASE_MARKER_MISSING");
  return { databaseName: row.database_name, databaseOid: String(row.database_oid) };
}

const fixtureSchemaSql = `
  create schema kapchi_fixture;

  create table kapchi_fixture.database_guard (
    singleton boolean primary key default true check (singleton),
    marker_id uuid not null,
    namespace text not null,
    database_oid text not null,
    database_name text not null,
    token_hash char(64) not null check (token_hash ~ '^[a-f0-9]{64}$'),
    initialized_at timestamptz not null default now()
  );

  create table kapchi_fixture.owned_rows (
    fixture_key text primary key,
    table_name text not null,
    row_id text not null,
    natural_key_hash char(64) not null check (natural_key_hash ~ '^[a-f0-9]{64}$'),
    immutable boolean not null,
    canonical_fingerprint char(64) not null check (canonical_fingerprint ~ '^[a-f0-9]{64}$'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (table_name, row_id),
    unique (table_name, natural_key_hash)
  );

  create table kapchi_fixture.admin_bindings (
    fixture_user_id uuid primary key,
    subject_hash char(64) not null check (subject_hash ~ '^[a-f0-9]{64}$'),
    bound_at timestamptz not null default now()
  );

  create table kapchi_fixture.catalog_attestations (
    fixture_key text primary key,
    marker_id uuid not null,
    stripe_account_id text not null,
    stripe_product_id text not null,
    stripe_price_id text not null,
    listing_slug text not null,
    variant_key text not null,
    customization_kind text not null,
    unit_amount_cents integer not null check (unit_amount_cents >= 0),
    currency char(3) not null,
    pricing_fingerprint char(64) not null check (pricing_fingerprint ~ '^[a-f0-9]{64}$'),
    livemode boolean not null check (livemode = false),
    attested_at timestamptz not null default now()
  );
`;

export async function initializeFixtureDatabase(input: {
  confirmDatabase: string | undefined;
  databaseUrl?: string;
  db: FixtureQueryable;
  nodeEnv?: string;
  token?: string;
}) {
  const target = parseSafeFixtureTarget(input.databaseUrl, input.nodeEnv);
  if (input.confirmDatabase !== target.databaseName) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_CONFIRMATION_MISMATCH");
  }
  const identity = await currentDatabaseIdentity(input.db);
  if (identity.databaseName !== target.databaseName) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_CONFIRMATION_MISMATCH");
  }

  const exists = await input.db.query<{ exists: boolean }>(
    "select to_regnamespace('kapchi_fixture') is not null as exists",
  );
  if (exists.rows[0]?.exists) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_ALREADY_INITIALIZED");
  }

  const token = input.token ?? randomBytes(32).toString("base64url");
  await input.db.query("begin");
  try {
    await input.db.query(fixtureSchemaSql);
    await input.db.query(
      `insert into kapchi_fixture.database_guard
         (marker_id, namespace, database_oid, database_name, token_hash)
       values ($1, $2, $3, $4, $5)`,
      [
        FIXTURE_MARKER_ID,
        FIXTURE_NAMESPACE,
        identity.databaseOid,
        identity.databaseName,
        sha256(token)
      ],
    );
    await input.db.query("commit");
  } catch (error) {
    await input.db.query("rollback");
    throw error;
  }
  return { databaseName: identity.databaseName, markerId: FIXTURE_MARKER_ID, token };
}

type GuardRow = QueryResultRow & {
  database_name: string;
  database_oid: string;
  marker_id: string;
  namespace: string;
  token_hash: string;
};

export async function assertInitializedFixtureDatabase(input: {
  databaseUrl?: string;
  db: FixtureQueryable;
  nodeEnv?: string;
  token?: string;
}) {
  const target = parseSafeFixtureTarget(input.databaseUrl, input.nodeEnv);
  if (!input.token) throw new FixtureSafetyError("FIXTURE_DATABASE_TOKEN_MISSING");
  const identity = await currentDatabaseIdentity(input.db);
  const result = await input.db.query<GuardRow>(
    `select marker_id::text, namespace, database_oid, database_name, token_hash
       from kapchi_fixture.database_guard where singleton = true`,
  ).catch(() => ({ rows: [] as GuardRow[] }));
  const guard = result.rows[0];
  if (!guard) throw new FixtureSafetyError("FIXTURE_DATABASE_MARKER_MISSING");
  if (
    guard.marker_id !== FIXTURE_MARKER_ID ||
    guard.namespace !== FIXTURE_NAMESPACE ||
    guard.database_name !== identity.databaseName ||
    guard.database_name !== target.databaseName ||
    guard.database_oid !== identity.databaseOid
  ) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_MARKER_MISMATCH");
  }
  if (guard.token_hash !== sha256(input.token)) {
    throw new FixtureSafetyError("FIXTURE_DATABASE_TOKEN_MISMATCH");
  }
  return { databaseName: identity.databaseName, databaseOid: identity.databaseOid };
}

export async function acquireFixtureTransactionLock(db: FixtureQueryable) {
  await db.query("select pg_advisory_xact_lock($1)", [FIXTURE_ADVISORY_LOCK_KEY]);
}

export function safeFixtureFailure(error: unknown) {
  if (error instanceof FixtureSafetyError) {
    return {
      event: "fixture.command.failed",
      errorCode: error.code,
      ...(error.fixtureKey ? { fixtureKey: error.fixtureKey } : {}),
      ...(error.tableAlias ? { tableAlias: error.tableAlias } : {})
    };
  }
  return {
    event: "fixture.command.failed",
    errorCode: "FIXTURE_UNEXPECTED_FAILURE",
    runId: randomUUID()
  };
}
