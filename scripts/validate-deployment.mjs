#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const forbiddenSecretValuePatterns = [
  /sk_(?:live|test)_[A-Za-z0-9]+/,
  /whsec_[A-Za-z0-9]+/,
  /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/,
  /redis(?:s)?:\/\/[^\s]+:[^\s]+@/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

export function validateDeploymentTemplate(text) {
  for (const pattern of forbiddenSecretValuePatterns) {
    assert.ok(!pattern.test(text), `deployment template contains a secret-like value: ${pattern}`);
  }
  for (const fragment of [
    "name: kapchi-api",
    "name: kapchi-worker",
    "name: migrate",
    "kind: PRE_DEPLOY",
    "name: operations-health",
    "kind: SCHEDULED",
    'cron: "*/15 * * * *"',
    "digest: RELEASE_IMAGE_DIGEST",
    "enabled: false",
    "http_path: /ready",
    "http_path: /health",
    "node dist/database/migrate.js apply && node dist/database/migrate.js check",
    "node dist/worker.js",
    "node dist/operations/health.js",
    "grace_period_seconds:",
    "rule: DEPLOYMENT_FAILED",
    "rule: DOMAIN_FAILED",
    "operator: GREATER_THAN",
    "window: FIVE_MINUTES"
  ]) {
    assert.ok(text.includes(fragment), `deployment template is missing: ${fragment}`);
  }
  assert.ok(!/tag:\s*(?:latest|main)/.test(text), "deployment image must be digest-pinned");
  assert.ok((text.match(/\*backend_image/g) ?? []).length >= 3, "worker and jobs must reuse the API image");
  return { componentCount: 4, imageMode: "digest-pinned" };
}

export function validateBackendDockerfile(text) {
  for (const fragment of [
    "FROM node:24.10.0-bookworm-slim AS build",
    "npm ci",
    "npm run build",
    "npm prune --omit=dev",
    "cp src/database/migrations/*.sql dist/database/migrations/",
    "COPY --chown=node:node --from=build /app/dist ./dist",
    "USER node",
    "EXPOSE 4000",
    'CMD ["node", "dist/server.js"]'
  ]) {
    assert.ok(text.includes(fragment), `backend Dockerfile is missing: ${fragment}`);
  }
  assert.ok(!/COPY\s+\.\s+\./.test(text), "backend Dockerfile must not copy the whole repository");
  assert.ok(!/(?:ARG|ENV)\s+(?:.*SECRET|.*TOKEN|DATABASE_URL)/.test(text), "backend Dockerfile must not accept secret build arguments");
  return { runtimeUser: "node", port: 4000 };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const filePath = process.argv[2] ?? path.join(root, "deploy/digitalocean.backend.template.yaml");
  const result = validateDeploymentTemplate(await readFile(filePath, "utf8"));
  const docker = validateBackendDockerfile(await readFile(path.join(root, "backend/Dockerfile"), "utf8"));
  console.log(JSON.stringify({ event: "deployment.template.validated", ...result, docker }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "deployment.template.invalid", errorCode: "DEPLOYMENT_TEMPLATE_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
