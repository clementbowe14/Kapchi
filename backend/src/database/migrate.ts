import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";

loadBackendEnvironment();

type AppliedMigration = {
  applied_at: Date;
  id: string;
  name: string;
};

type MigrationFile = {
  id: string;
  name: string;
  path: string;
};

const migrationsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const migrationsTableName = "schema_migrations";

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  return databaseUrl;
}

function createMigrationPool() {
  return new Pool({
    connectionString: getDatabaseUrl(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 1)
  });
}

function normalizeMigrationName(rawName: string | undefined) {
  const name = rawName?.trim();

  if (!name) {
    throw new Error(
      "Provide a migration name, for example: npm run db:migrate:create -- add_order_notes",
    );
  }

  const normalizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalizedName) {
    throw new Error("Migration names must include at least one letter or number.");
  }

  return normalizedName;
}

async function listMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const id = entry.name.replace(/\.sql$/, "");

      return {
        id,
        name: entry.name,
        path: path.join(migrationsDirectory, entry.name)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function ensureMigrationsTable(pool: Pool) {
  await pool.query(`
    create table if not exists ${migrationsTableName} (
      id text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedMigrations(pool: Pool) {
  await ensureMigrationsTable(pool);

  const result = await pool.query<AppliedMigration>(`
    select id, name, applied_at
    from ${migrationsTableName}
    order by applied_at asc, id asc
  `);

  return result.rows;
}

async function createMigration(name: string | undefined) {
  const normalizedName = normalizeMigrationName(name);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
  const fileName = `${timestamp}_${normalizedName}.sql`;
  const filePath = path.join(migrationsDirectory, fileName);

  await writeFile(
    filePath,
    `-- ${normalizedName.replace(/_/g, " ")}\n\n-- Write forward-only SQL changes here.\n`,
    { flag: "wx" },
  );

  console.log(`Created ${path.relative(process.cwd(), filePath)}`);
}

async function applyMigrations() {
  const pool = createMigrationPool();

  try {
    const files = await listMigrationFiles();
    const applied = new Set((await getAppliedMigrations(pool)).map((row) => row.id));
    const pending = files.filter((file) => !applied.has(file.id));

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const migration of pending) {
      const sql = await readFile(migration.path, "utf8");
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          `insert into ${migrationsTableName} (id, name) values ($1, $2)`,
          [migration.id, migration.name],
        );
        await client.query("commit");
        console.log(`Applied ${migration.name}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function printStatus() {
  const pool = createMigrationPool();

  try {
    const files = await listMigrationFiles();
    const applied = new Set((await getAppliedMigrations(pool)).map((row) => row.id));

    for (const migration of files) {
      const state = applied.has(migration.id) ? "applied" : "pending";
      console.log(`${state.padEnd(8)} ${migration.name}`);
    }
  } finally {
    await pool.end();
  }
}

async function printHistory() {
  const pool = createMigrationPool();

  try {
    const rows = await getAppliedMigrations(pool);

    if (rows.length === 0) {
      console.log("No migrations have been applied.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.applied_at.toISOString()} ${row.name}`);
    }
  } finally {
    await pool.end();
  }
}

function assertLocalResetAllowed() {
  const databaseUrl = new URL(getDatabaseUrl());
  const hostname = databaseUrl.hostname;
  const databaseName = databaseUrl.pathname.replace(/^\//, "");
  const force = process.argv.includes("--force");
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const isLocalName = /(?:^|_)(dev|test|local)(?:_|$)/i.test(databaseName);
  const isProduction = process.env.NODE_ENV === "production";

  if (!force || isProduction || !isLocalHost || !isLocalName) {
    throw new Error(
      [
        "Refusing to reset the database.",
        "Reset requires --force, NODE_ENV must not be production,",
        "DATABASE_URL must point at localhost, and the database name must include dev, test, or local."
      ].join(" "),
    );
  }
}

async function resetLocalDatabase() {
  assertLocalResetAllowed();

  const pool = createMigrationPool();

  try {
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    await pool.query("grant all on schema public to public");
    console.log("Reset local public schema.");
  } finally {
    await pool.end();
  }

  await applyMigrations();
}

async function main() {
  const [, , command, name] = process.argv;

  switch (command) {
    case "apply":
      await applyMigrations();
      break;
    case "create":
      await createMigration(name);
      break;
    case "history":
      await printHistory();
      break;
    case "reset":
      await resetLocalDatabase();
      break;
    case "status":
      await printStatus();
      break;
    default:
      throw new Error("Unknown command. Use create, apply, status, history, or reset.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
