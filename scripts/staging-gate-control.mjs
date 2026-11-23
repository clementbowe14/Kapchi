#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ATTEMPT = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const TERMINAL = new Set(["cleaned", "terminal-isolated"]);
const ALLOWED_PROVIDER_RETAINED = new Set(["stripe", "messaging"]);
const PROVIDERS = new Set(["alias", "database", "redis", "stripe", "clerk", "blob", "messaging"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function digestControlRecord(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deterministicStagingNamespace(attemptId, candidateSha) {
  assert.match(attemptId ?? "", ATTEMPT, "attemptId is invalid");
  assert.match(candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  const attempt = attemptId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  const digest = createHash("sha256")
    .update(`${attemptId}:${candidateSha}`)
    .digest("hex")
    .slice(0, 12);
  return `kapchi-stg-${attempt}-${digest}`;
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} must be an ISO timestamp`);
  return parsed;
}

function hash(value, label) {
  assert.match(value ?? "", SHA256, `${label} must be a SHA-256 digest`);
}

export function buildResourceControlReport(exported, { generatedAt = new Date().toISOString() } = {}) {
  assert.equal(exported.exportVersion, 2, "ledger export version must be 2");
  assert.equal(exported.environment, "staging", "resource ledger must be staging-only");
  assert.match(exported.attemptId ?? "", ATTEMPT, "attemptId is invalid");
  assert.match(exported.candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  hash(exported.ownerTokenHash, "ownerTokenHash");
  assert.ok(Array.isArray(exported.productionDenylistHashes) && exported.productionDenylistHashes.length > 0, "production denylist is required");
  exported.productionDenylistHashes.forEach((entry, index) => hash(entry, `productionDenylistHashes[${index}]`));
  const denylist = new Set(exported.productionDenylistHashes);
  const expectedNamespace = deterministicStagingNamespace(exported.attemptId, exported.candidateSha);
  assert.ok(Array.isArray(exported.expectedResources) && exported.expectedResources.length > 0, "expected resource inventory must be non-empty");
  const expectedSeen = new Set();
  const expectedResources = exported.expectedResources.map((resource, index) => {
    const label = `expectedResources[${index}]`;
    assert.deepEqual(
      Object.keys(resource).sort(),
      ["provider", "namespace", "idempotencyKeyHash", "expectedAccountHash", "expectedProjectHash"].sort(),
      `${label} keys do not match the contract`,
    );
    assert.ok(PROVIDERS.has(resource.provider), `${label}.provider is invalid`);
    assert.equal(resource.namespace, expectedNamespace, `${label}.namespace is not attempt-owned`);
    hash(resource.idempotencyKeyHash, `${label}.idempotencyKeyHash`);
    hash(resource.expectedAccountHash, `${label}.expectedAccountHash`);
    if (resource.expectedProjectHash !== null) hash(resource.expectedProjectHash, `${label}.expectedProjectHash`);
    assert.ok(!denylist.has(resource.expectedAccountHash), `${label} targets a production account`);
    assert.ok(resource.expectedProjectHash === null || !denylist.has(resource.expectedProjectHash), `${label} targets a production project`);
    const unique = `${resource.provider}:${resource.idempotencyKeyHash}`;
    assert.ok(!expectedSeen.has(unique), `${label} duplicates a provider idempotency key`);
    expectedSeen.add(unique);
    return { ...resource };
  }).sort((left, right) => `${left.provider}:${left.idempotencyKeyHash}`.localeCompare(`${right.provider}:${right.idempotencyKeyHash}`));
  assert.ok(Array.isArray(exported.resources), "resources must be an array");
  const seen = new Set();
  const resources = exported.resources.map((resource, index) => {
    const label = `resources[${index}]`;
    assert.ok(PROVIDERS.has(resource.provider), `${label}.provider is invalid`);
    assert.equal(resource.namespace, expectedNamespace, `${label}.namespace is not attempt-owned`);
    assert.ok(typeof resource.idempotencyKey === "string" && resource.idempotencyKey.length >= 8, `${label}.idempotencyKey is invalid`);
    const unique = `${resource.provider}:${resource.idempotencyKey}`;
    assert.ok(!seen.has(unique), `${label} duplicates a provider idempotency key`);
    seen.add(unique);
    hash(resource.expectedAccountHash, `${label}.expectedAccountHash`);
    if (resource.expectedProjectHash !== null) hash(resource.expectedProjectHash, `${label}.expectedProjectHash`);
    assert.ok(!denylist.has(resource.expectedAccountHash), `${label} targets a production account`);
    assert.ok(resource.expectedProjectHash === null || !denylist.has(resource.expectedProjectHash), `${label} targets a production project`);
    const intentAt = timestamp(resource.intentRecordedAt, `${label}.intentRecordedAt`);
    const callAt = resource.providerCallStartedAt === null ? null : timestamp(resource.providerCallStartedAt, `${label}.providerCallStartedAt`);
    assert.ok(callAt === null || intentAt <= callAt, `${label} provider call started before its write-ahead intent`);
    assert.ok(["creation-pending", "bound", "cleanup-pending", "cleaned", "terminal-isolated", "cleanup-failed"].includes(resource.state), `${label}.state is invalid`);
    if (["bound", "cleaned", "terminal-isolated"].includes(resource.state)) hash(resource.handleHash, `${label}.handleHash`);
    if (resource.state === "cleaned") {
      assert.equal(resource.absenceVerified, true, `${label} cleaned resource requires absence verification`);
      timestamp(resource.cleanupVerifiedAt, `${label}.cleanupVerifiedAt`);
    }
    if (resource.state === "terminal-isolated") {
      assert.ok(ALLOWED_PROVIDER_RETAINED.has(resource.provider), `${label} provider may not be retained`);
      assert.equal(resource.terminalStateVerified, true, `${label} retained resource requires terminal-state verification`);
      timestamp(resource.cleanupVerifiedAt, `${label}.cleanupVerifiedAt`);
    }
    return {
      provider: resource.provider,
      namespace: resource.namespace,
      idempotencyKeyHash: createHash("sha256").update(resource.idempotencyKey).digest("hex"),
      expectedAccountHash: resource.expectedAccountHash,
      expectedProjectHash: resource.expectedProjectHash,
      state: resource.state,
      handleHash: resource.handleHash,
      intentRecordedAt: resource.intentRecordedAt,
      providerCallStartedAt: resource.providerCallStartedAt,
      cleanupVerifiedAt: resource.cleanupVerifiedAt,
      absenceVerified: resource.absenceVerified,
      terminalStateVerified: resource.terminalStateVerified
    };
  });
  const actualInventory = resources.map(({ provider, namespace, idempotencyKeyHash, expectedAccountHash, expectedProjectHash }) => ({
    provider,
    namespace,
    idempotencyKeyHash,
    expectedAccountHash,
    expectedProjectHash
  })).sort((left, right) => `${left.provider}:${left.idempotencyKeyHash}`.localeCompare(`${right.provider}:${right.idempotencyKeyHash}`));
  assert.deepEqual(actualInventory, expectedResources, "expected resource inventory does not exactly match exported ledger records");
  const status = resources.some(({ state }) => state === "cleanup-failed")
    ? "fail"
    : resources.every(({ state }) => TERMINAL.has(state)) ? "pass" : "pending";
  const report = {
    reportVersion: 2,
    reportType: "staging-resource-control",
    trustMode: "single-owner-procedural",
    generatedBy: "scripts/staging-gate-control.mjs",
    environment: "staging",
    attemptId: exported.attemptId,
    candidateSha: exported.candidateSha,
    ownerTokenHash: exported.ownerTokenHash,
    generatedAt,
    expectedResourceCount: expectedResources.length,
    expectedResourceDigest: digestControlRecord(expectedResources),
    resources,
    status
  };
  return { ...report, reportDigest: digestControlRecord(report) };
}

export function validateResourceControlReport(report, exported) {
  const rebuilt = buildResourceControlReport(exported, { generatedAt: report.generatedAt });
  assert.deepEqual(report, rebuilt, "resource control report is not derived from the ledger export");
  return {
    status: report.status,
    resourceCount: report.resources.length,
    expectedResourceCount: report.expectedResourceCount,
    expectedResourceDigest: report.expectedResourceDigest,
    reportDigest: report.reportDigest
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1]) throw new Error(`Use ${flag} <path>`);
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "build-report") throw new Error("Use build-report --input <ledger-export.json> --output <report.json>");
  const input = JSON.parse(await readFile(valueAfter(argv, "--input"), "utf8"));
  const report = buildResourceControlReport(input);
  validateResourceControlReport(report, input);
  const output = valueAfter(argv, "--output");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.gate.control.failed", errorCode: "STAGING_GATE_CONTROL_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
