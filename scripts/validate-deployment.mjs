#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedCrons = new Map([
  ["/internal/cron/messages", "* * * * *"],
  ["/internal/cron/refunds", "* * * * *"],
  ["/internal/cron/inventory", "*/5 * * * *"],
  ["/internal/cron/maintenance", "*/15 * * * *"],
  ["/internal/cron/health", "*/15 * * * *"]
]);

const forbiddenSecretValuePatterns = [
  /sk_(?:live|test)_[A-Za-z0-9]+/,
  /whsec_[A-Za-z0-9]+/,
  /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/,
  /redis(?:s)?:\/\/[^\s]+:[^\s]+@/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

export function validateVercelConfiguration(text) {
  for (const pattern of forbiddenSecretValuePatterns) {
    assert.ok(!pattern.test(text), `Vercel configuration contains a secret-like value: ${pattern}`);
  }
  const configuration = JSON.parse(text);
  assert.equal(configuration.$schema, "https://openapi.vercel.sh/vercel.json");
  assert.deepEqual(Object.keys(configuration.functions ?? {}), ["src/server.ts"], "Fastify must use its documented Vercel entrypoint");
  assert.equal(configuration.functions["src/server.ts"].maxDuration, 60, "backend function must have a bounded duration");
  assert.equal(configuration.crons?.length, expectedCrons.size, "unexpected cron route count");
  for (const cron of configuration.crons) {
    assert.equal(expectedCrons.get(cron.path), cron.schedule, `unexpected cron definition for ${cron.path}`);
  }
  return { cronCount: configuration.crons.length, entrypoint: "src/server.ts", platform: "vercel" };
}

export function validateMigrationWorkflow(text) {
  for (const fragment of [
    "workflow_dispatch:",
    "environment: production",
    "group: production-database-migration",
    "cancel-in-progress: false",
    "VERCEL_BACKEND_PROJECT_ID",
    "vercel@65.9.0 pull",
    "vercel@65.9.0 env run -e production -- npm run db:migrate:apply",
    "vercel@65.9.0 env run -e production -- npm run db:migrate:check"
  ]) {
    assert.ok(text.includes(fragment), `migration workflow is missing: ${fragment}`);
  }
  assert.ok(!text.includes("DATABASE_URL:"), "migration workflow must not copy database secrets into GitHub");
  return { migrationEnvironment: "vercel-production", serialized: true };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configuration = validateVercelConfiguration(await readFile(path.join(root, "backend/vercel.json"), "utf8"));
  const workflow = validateMigrationWorkflow(await readFile(path.join(root, ".github/workflows/production-migrate.yml"), "utf8"));
  console.log(JSON.stringify({ event: "deployment.configuration.validated", ...configuration, ...workflow }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "deployment.configuration.invalid", errorCode: "DEPLOYMENT_CONFIGURATION_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
