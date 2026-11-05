import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMigrationWorkflow, validateVercelConfiguration } from "./validate-deployment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Vercel configuration declares the Fastify function and bounded cron routes", async () => {
  const text = await readFile(path.join(root, "backend/vercel.json"), "utf8");
  assert.deepEqual(validateVercelConfiguration(text), { cronCount: 5, entrypoint: "src/server.ts", platform: "vercel" });
});

test("production migrations are protected, serialized, and use the Vercel environment", async () => {
  const text = await readFile(path.join(root, ".github/workflows/production-migrate.yml"), "utf8");
  assert.deepEqual(validateMigrationWorkflow(text), { migrationEnvironment: "vercel-production", serialized: true });
});

test("configuration validator rejects real-looking credentials", () => {
  const fakeCredential = ["sk", "live", "synthetic_validation_value"].join("_");
  assert.throws(() => validateVercelConfiguration(fakeCredential), /secret-like value/);
});
