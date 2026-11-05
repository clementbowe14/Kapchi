#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const requiredIds = new Set([
  "backend-5xx",
  "public-readiness",
  "postgresql",
  "redis",
  "stripe-webhook",
  "background-jobs",
  "deployment-migration"
]);
const requiredFields = [
  "id",
  "owner",
  "severity",
  "provider",
  "signal",
  "queryFile",
  "threshold",
  "window",
  "destinationClass",
  "runbookSection",
  "evidence"
];

function isPlaceholder(value) {
  return /(?:PLACEHOLDER|EVIDENCE_URL|REPLACE_ME|TBD)/i.test(String(value));
}

export async function validateAlertInventory({
  inventoryPath,
  requireEvidence = false,
  rootDirectory = process.cwd()
}) {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assert.equal(inventory.schemaVersion, 1, "alert inventory schemaVersion must be 1");
  assert.ok(Array.isArray(inventory.alerts), "alert inventory must contain alerts");

  const seen = new Set();
  for (const alert of inventory.alerts) {
    for (const field of requiredFields) {
      assert.ok(String(alert[field] ?? "").trim(), `${alert.id ?? "unknown"}.${field} is required`);
    }
    assert.ok(!seen.has(alert.id), `duplicate alert id: ${alert.id}`);
    seen.add(alert.id);
    assert.equal(
      alert.destinationClass,
      "primary-and-secondary",
      `${alert.id} must notify primary and secondary destinations`,
    );
    if (requireEvidence) {
      assert.ok(!isPlaceholder(alert.evidence), `${alert.id} evidence is still a placeholder`);
      assert.match(alert.evidence, /^https:\/\//, `${alert.id} evidence must be HTTPS`);
    }

    const queryPath = path.resolve(rootDirectory, alert.queryFile);
    const query = JSON.parse(await readFile(queryPath, "utf8"));
    assert.equal(query.provider, alert.provider, `${alert.id} provider differs from its query`);
    assert.ok(String(query.query ?? "").trim(), `${alert.id} query is empty`);
    assert.ok(Array.isArray(query.aggregation) && query.aggregation.length > 0, `${alert.id} aggregation is required`);
    assert.ok(String(query.redaction ?? "").trim(), `${alert.id} redaction rule is required`);
  }

  assert.deepEqual(seen, requiredIds, "alert inventory must contain exactly the required stable IDs");
  return { alertCount: seen.size, evidenceRequired: requireEvidence };
}

async function main() {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const requireEvidence = process.argv.includes("--require-evidence");
  const result = await validateAlertInventory({
    inventoryPath: path.join(rootDirectory, "deploy/alerts/inventory.json"),
    requireEvidence,
    rootDirectory
  });
  console.log(JSON.stringify({ event: "alerts.inventory.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "alerts.inventory.invalid", errorCode: "ALERT_INVENTORY_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
