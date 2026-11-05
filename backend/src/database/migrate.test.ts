import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MigrationError, applyMigrations, inspectMigrationState, listMigrationFiles, migrationChecksum, selectMigrationDatabaseUrl, validateMigrationLedger } from "./migrate.js";

describe("migration controls", () => {
  it("requires a direct connection in production", () => {
    expect(selectMigrationDatabaseUrl({ NODE_ENV: "test", DATABASE_URL: "postgres://local/test" })).toBe("postgres://local/test");
    expect(() => selectMigrationDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://pool/prod" })).toThrowError(MigrationError);
    expect(selectMigrationDatabaseUrl({ NODE_ENV: "production", DATABASE_DIRECT_URL: "postgres://direct/prod" })).toBe("postgres://direct/prod");
  });

  it("loads SHA-256 checksums and rejects ledger drift", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kapchi-migrations-"));
    await writeFile(path.join(directory, "001_first.sql"), "select 1;\n");
    const files = await listMigrationFiles(directory);
    expect(files[0]?.checksum).toBe(migrationChecksum("select 1;\n"));
    expect(() => validateMigrationLedger(files, [{ applied_at: new Date(), checksum: "wrong", id: "001_first", name: "001_first.sql" }], true)).toThrowError(MigrationError);
  });

  it("uses only read queries while inspecting an absent ledger", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kapchi-migrations-"));
    await writeFile(path.join(directory, "001_first.sql"), "select 1;\n");
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ledger: null }] });
    const result = await inspectMigrationState({ query } as never, { directory });
    expect(result.pending).toHaveLength(1);
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toMatch(/^select to_regclass/);
  });

  it("holds one advisory lock for the full no-op apply run", async () => {
    const files = await listMigrationFiles();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id, name, checksum, applied_at")) {
        return { rows: files.map((file) => ({ applied_at: new Date(), checksum: file.checksum, id: file.id, name: file.name })) };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const end = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })), end };

    await expect(applyMigrations({ environment: { NODE_ENV: "test" }, pool: pool as never })).resolves.toEqual({ appliedCount: 0 });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      "select pg_advisory_lock($1)",
      "select pg_advisory_unlock($1)"
    ]));
    expect(release).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });
});
