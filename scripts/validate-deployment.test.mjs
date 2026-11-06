import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFastifyEntrypoint, validateMigrationWorkflow, validateProCronTemplate } from "./validate-deployment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Fastify uses Vercel zero-configuration entrypoint detection", async () => {
  const text = await readFile(path.join(root, "backend/src/server.ts"), "utf8");
  assert.deepEqual(validateFastifyEntrypoint(text), { entrypoint: "src/server.ts", platform: "vercel-zero-config" });
});

test("Pro cron template preserves the required production cadence", async () => {
  const text = await readFile(path.join(root, "deploy/vercel.crons.pro.template.json"), "utf8");
  assert.deepEqual(validateProCronTemplate(text), { plannedCronCount: 5, requiredPlan: "pro-or-external-scheduler" });
});

test("production migrations are protected, serialized, and use the Vercel environment", async () => {
  const text = await readFile(path.join(root, ".github/workflows/production-migrate.yml"), "utf8");
  assert.deepEqual(validateMigrationWorkflow(text), { migrationEnvironment: "vercel-production", serialized: true });
});

test("cron template validator rejects real-looking credentials", () => {
  const fakeCredential = ["sk", "live", "synthetic_validation_value"].join("_");
  assert.throws(() => validateProCronTemplate(fakeCredential), /secret-like value/);
});
