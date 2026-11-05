import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";

export const migrationExitCodes = { success: 0, configuration: 10, lockTimeout: 11, pending: 12, drift: 13, execution: 14 } as const;
const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const migrationsTableName = "schema_migrations";
const migrationAdvisoryLock = 1_140_114;

type AppliedMigration = { applied_at: Date; checksum: string | null; id: string; name: string };
export type MigrationFile = { checksum: string; id: string; name: string; path: string; sql: string };
export type MigrationState = { applied: AppliedMigration[]; files: MigrationFile[]; pending: MigrationFile[] };

export class MigrationError extends Error {
  constructor(
    public readonly errorCode: "MIGRATION_CONFIGURATION_INVALID" | "MIGRATION_EXECUTION_FAILED" | "MIGRATION_LEDGER_DRIFT" | "MIGRATION_LOCK_TIMEOUT" | "MIGRATIONS_PENDING",
    public readonly exitCode: number,
    public readonly migrationId?: string,
  ) {
    super(errorCode);
    this.name = "MigrationError";
  }
}

export function selectMigrationDatabaseUrl(environment: NodeJS.ProcessEnv = process.env) {
  const direct = environment.DATABASE_DIRECT_URL?.trim();
  if (direct) return direct;
  if (environment.NODE_ENV === "production") throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
  const pooled = environment.DATABASE_URL?.trim();
  if (!pooled) throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
  return pooled;
}

export function migrationChecksum(sql: string) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function listMigrationFiles(directory = migrationsDirectory): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map(async (entry) => {
    const sql = await readFile(path.join(directory, entry.name), "utf8");
    return { checksum: migrationChecksum(sql), id: entry.name.replace(/\.sql$/, ""), name: entry.name, path: path.join(directory, entry.name), sql };
  }));
  files.sort((left, right) => left.name.localeCompare(right.name));
  const ids = new Set<string>();
  for (const file of files) {
    if (ids.has(file.id)) throw new MigrationError("MIGRATION_LEDGER_DRIFT", migrationExitCodes.drift, file.id);
    ids.add(file.id);
  }
  return files;
}

async function ensureMigrationsTable(client: PoolClient) {
  await client.query(`create table if not exists ${migrationsTableName} (id text primary key, name text not null, checksum text, applied_at timestamptz not null default now())`);
  await client.query(`alter table ${migrationsTableName} add column if not exists checksum text`);
}

async function readAppliedMigrations(queryable: Pick<PoolClient, "query">): Promise<AppliedMigration[]> {
  const result = await queryable.query<AppliedMigration>(`select id, name, checksum, applied_at from ${migrationsTableName} order by applied_at asc, id asc`);
  return result.rows;
}

export function validateMigrationLedger(files: MigrationFile[], applied: AppliedMigration[], requireChecksums: boolean) {
  const fileById = new Map(files.map((file) => [file.id, file]));
  const seen = new Set<string>();
  for (const row of applied) {
    const file = fileById.get(row.id);
    if (seen.has(row.id) || !file || row.name !== file.name || (row.checksum && row.checksum !== file.checksum) || (requireChecksums && !row.checksum)) {
      throw new MigrationError("MIGRATION_LEDGER_DRIFT", migrationExitCodes.drift, row.id);
    }
    seen.add(row.id);
  }
}

export async function inspectMigrationState(queryable: Pick<Pool, "query">, options: { requireChecksums?: boolean; directory?: string } = {}): Promise<MigrationState> {
  const files = await listMigrationFiles(options.directory);
  const exists = await queryable.query<{ ledger: string | null }>(`select to_regclass('public.${migrationsTableName}')::text as ledger`);
  if (!exists.rows[0]?.ledger) return { applied: [], files, pending: files };
  const columns = await queryable.query<{ exists: boolean }>(`select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${migrationsTableName}' and column_name = 'checksum')`);
  if (!columns.rows[0]?.exists) throw new MigrationError("MIGRATION_LEDGER_DRIFT", migrationExitCodes.drift);
  const applied = await readAppliedMigrations(queryable as Pick<PoolClient, "query">);
  validateMigrationLedger(files, applied, options.requireChecksums ?? process.env.NODE_ENV === "production");
  const ids = new Set(applied.map((row) => row.id));
  return { applied, files, pending: files.filter((file) => !ids.has(file.id)) };
}

function migrationPool(environment: NodeJS.ProcessEnv = process.env) {
  return new Pool({ connectionString: selectMigrationDatabaseUrl(environment), max: 1 });
}

export async function applyMigrations(options: { environment?: NodeJS.ProcessEnv; lockTimeoutMs?: number; pool?: Pool } = {}) {
  const environment = options.environment ?? process.env;
  const pool = options.pool ?? migrationPool(environment);
  const client = await pool.connect();
  try {
    await client.query(`set lock_timeout = '${Math.max(1, options.lockTimeoutMs ?? 60_000)}ms'`);
    try {
      await client.query("select pg_advisory_lock($1)", [migrationAdvisoryLock]);
    } catch {
      throw new MigrationError("MIGRATION_LOCK_TIMEOUT", migrationExitCodes.lockTimeout);
    }
    await ensureMigrationsTable(client);
    const files = await listMigrationFiles();
    const applied = await readAppliedMigrations(client);
    validateMigrationLedger(files, applied, environment.NODE_ENV === "production");
    const appliedIds = new Set(applied.map((row) => row.id));
    let appliedCount = 0;
    for (const migration of files.filter((file) => !appliedIds.has(file.id))) {
      try {
        await client.query("begin");
        await client.query(migration.sql);
        await client.query(`insert into ${migrationsTableName} (id, name, checksum) values ($1, $2, $3)`, [migration.id, migration.name, migration.checksum]);
        await client.query("commit");
        appliedCount += 1;
      } catch {
        await client.query("rollback").catch(() => undefined);
        throw new MigrationError("MIGRATION_EXECUTION_FAILED", migrationExitCodes.execution, migration.id);
      }
    }
    return { appliedCount };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [migrationAdvisoryLock]).catch(() => undefined);
    client.release();
    if (!options.pool) await pool.end();
  }
}

export async function checkMigrations(options: { environment?: NodeJS.ProcessEnv; pool?: Pool } = {}) {
  const environment = options.environment ?? process.env;
  const pool = options.pool ?? migrationPool(environment);
  try {
    const state = await inspectMigrationState(pool, { requireChecksums: environment.NODE_ENV === "production" });
    if (state.pending.length > 0) throw new MigrationError("MIGRATIONS_PENDING", migrationExitCodes.pending, state.pending[0]?.id);
    return state;
  } finally {
    if (!options.pool) await pool.end();
  }
}

export async function baselineMigrationChecksums(confirmDatabase: string | undefined, environment = process.env) {
  if (!confirmDatabase) throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
  const pool = migrationPool(environment);
  const client = await pool.connect();
  try {
    await client.query("set lock_timeout = '60000ms'");
    try {
      await client.query("select pg_advisory_lock($1)", [migrationAdvisoryLock]);
    } catch {
      throw new MigrationError("MIGRATION_LOCK_TIMEOUT", migrationExitCodes.lockTimeout);
    }
    const identity = await client.query<{ database_name: string }>("select current_database() as database_name");
    if (identity.rows[0]?.database_name !== confirmDatabase) throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
    await ensureMigrationsTable(client);
    const files = await listMigrationFiles();
    const applied = await readAppliedMigrations(client);
    validateMigrationLedger(files, applied, false);
    const fileById = new Map(files.map((file) => [file.id, file]));
    await client.query("begin");
    for (const row of applied.filter((entry) => !entry.checksum)) {
      await client.query(`update ${migrationsTableName} set checksum = $2 where id = $1 and checksum is null`, [row.id, fileById.get(row.id)!.checksum]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [migrationAdvisoryLock]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

function normalizeMigrationName(rawName: string | undefined) {
  const name = rawName?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
  return name;
}

async function createMigration(name: string | undefined) {
  const normalized = normalizeMigrationName(name);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const filePath = path.join(migrationsDirectory, `${timestamp}_${normalized}.sql`);
  await writeFile(filePath, `-- ${normalized.replace(/_/g, " ")}\n\n-- Write forward-only SQL changes here.\n`, { flag: "wx" });
  console.info(`Created ${path.relative(process.cwd(), filePath)}`);
}

async function printMigrationState(command: "history" | "status", environment = process.env) {
  const pool = migrationPool(environment);
  try {
    const state = await inspectMigrationState(pool, { requireChecksums: environment.NODE_ENV === "production" });
    if (command === "status") {
      const appliedIds = new Set(state.applied.map((row) => row.id));
      for (const migration of state.files) {
        console.info(`${(appliedIds.has(migration.id) ? "applied" : "pending").padEnd(8)} ${migration.name}`);
      }
      return state;
    }
    if (state.applied.length === 0) {
      console.info("No migrations have been applied.");
      return state;
    }
    for (const migration of state.applied) {
      console.info(`${migration.applied_at.toISOString()} ${migration.name}`);
    }
    return state;
  } finally {
    await pool.end();
  }
}

function assertLocalResetAllowed(environment = process.env, argv = process.argv) {
  const url = new URL(environment.DATABASE_URL ?? "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const localName = /(?:^|_)(dev|test|local)(?:_|$)/i.test(url.pathname.replace(/^\//, ""));
  if (!argv.includes("--force") || environment.NODE_ENV === "production" || !local || !localName) throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
}

async function resetLocalDatabase(environment = process.env) {
  assertLocalResetAllowed(environment);
  const pool = migrationPool(environment);
  try {
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    await pool.query("grant all on schema public to public");
  } finally {
    await pool.end();
  }
  await applyMigrations({ environment });
}

export async function runMigrationCli(argv = process.argv, environment = process.env) {
  loadBackendEnvironment();
  const command = argv[2];
  if (command === "apply") return applyMigrations({ environment });
  if (command === "check") return checkMigrations({ environment });
  if (command === "baseline-checksums") {
    const index = argv.indexOf("--confirm-database");
    return baselineMigrationChecksums(index >= 0 ? argv[index + 1] : undefined, environment);
  }
  if (command === "create") return createMigration(argv[3]);
  if (command === "reset") return resetLocalDatabase(environment);
  if (command === "status" || command === "history") return printMigrationState(command, environment);
  throw new MigrationError("MIGRATION_CONFIGURATION_INVALID", migrationExitCodes.configuration);
}

function sanitizedFailure(error: unknown, runId: string) {
  const migration = error instanceof MigrationError ? error : new MigrationError("MIGRATION_EXECUTION_FAILED", migrationExitCodes.execution);
  return { output: JSON.stringify({ event: "database.migration.failed", errorCode: migration.errorCode, ...(migration.migrationId ? { migrationId: migration.migrationId } : {}), runId }), exitCode: migration.exitCode };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const runId = randomUUID();
  runMigrationCli().then(() => console.info(JSON.stringify({ event: "database.migration.completed", runId }))).catch((error) => {
    const failure = sanitizedFailure(error, runId);
    console.error(failure.output);
    process.exitCode = failure.exitCode;
  });
}
