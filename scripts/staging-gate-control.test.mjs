import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildResourceControlReport,
  deterministicStagingNamespace,
  validateResourceControlReport,
} from "./staging-gate-control.mjs";

const attemptId = "stg_attempt_12345";
const candidateSha = "a".repeat(40);
const namespace = deterministicStagingNamespace(attemptId, candidateSha);

const base = {
  exportVersion: 2,
  environment: "staging",
  attemptId,
  candidateSha,
  ownerTokenHash: "b".repeat(64),
  productionDenylistHashes: ["f".repeat(64)],
  expectedResources: [{
    provider: "blob",
    namespace,
    idempotencyKeyHash: createHash("sha256").update("stg_attempt_12345:blob:artwork").digest("hex"),
    expectedAccountHash: "c".repeat(64),
    expectedProjectHash: "d".repeat(64)
  }],
  resources: [
    {
      provider: "blob",
      namespace,
      idempotencyKey: "stg_attempt_12345:blob:artwork",
      expectedAccountHash: "c".repeat(64),
      expectedProjectHash: "d".repeat(64),
      state: "cleaned",
      handleHash: "e".repeat(64),
      intentRecordedAt: "2026-11-23T10:00:00.000Z",
      providerCallStartedAt: "2026-11-23T10:00:01.000Z",
      cleanupVerifiedAt: "2026-11-23T11:00:00.000Z",
      absenceVerified: true,
      terminalStateVerified: false
    }
  ]
};

test("derives passing cleanup evidence from terminal owned resources", () => {
  const report = buildResourceControlReport(base, { generatedAt: "2026-11-23T12:00:00.000Z" });
  assert.equal(report.status, "pass");
  assert.equal(validateResourceControlReport(report, base).resourceCount, 1);
  assert.equal(report.expectedResourceCount, 1);
});

test("rejects empty, missing, or unexpected resource inventories", () => {
  const empty = structuredClone(base);
  empty.expectedResources = [];
  empty.resources = [];
  assert.throws(() => buildResourceControlReport(empty), /inventory must be non-empty/);

  const missing = structuredClone(base);
  missing.resources = [];
  assert.throws(() => buildResourceControlReport(missing), /does not exactly match/);

  const unexpected = structuredClone(base);
  unexpected.expectedResources[0].namespace = `${base.expectedResources[0].namespace}/different`;
  assert.throws(() => buildResourceControlReport(unexpected), /not attempt-owned/);
});

test("keeps unfinished resource intents pending", () => {
  const exported = structuredClone(base);
  exported.resources[0].state = "creation-pending";
  exported.resources[0].handleHash = null;
  exported.resources[0].providerCallStartedAt = null;
  exported.resources[0].cleanupVerifiedAt = null;
  exported.resources[0].absenceVerified = false;
  assert.equal(buildResourceControlReport(exported).status, "pending");
});

test("requires write-ahead intent before a provider call", () => {
  const exported = structuredClone(base);
  exported.resources[0].providerCallStartedAt = "2026-11-23T09:59:59.000Z";
  assert.throws(() => buildResourceControlReport(exported), /before its write-ahead intent/);
});

test("rejects production identities and unowned namespaces", () => {
  const production = structuredClone(base);
  production.resources[0].expectedAccountHash = "f".repeat(64);
  assert.throws(() => buildResourceControlReport(production), /production account/);

  const unowned = structuredClone(base);
  unowned.resources[0].namespace = "kapchi/unowned/artwork";
  assert.throws(() => buildResourceControlReport(unowned), /not attempt-owned/);
});

test("allows retained terminal objects only for approved providers", () => {
  const retained = structuredClone(base);
  retained.resources[0].state = "terminal-isolated";
  retained.resources[0].terminalStateVerified = true;
  assert.throws(() => buildResourceControlReport(retained), /may not be retained/);

  retained.resources[0].provider = "stripe";
  retained.expectedResources[0].provider = "stripe";
  assert.equal(buildResourceControlReport(retained).status, "pass");
});

test("uses the ledger alias resource kind for Vercel routing resources", () => {
  const alias = structuredClone(base);
  alias.resources[0].provider = "alias";
  alias.expectedResources[0].provider = "alias";
  assert.equal(buildResourceControlReport(alias).status, "pass");

  const legacyVercel = structuredClone(alias);
  legacyVercel.resources[0].provider = "vercel";
  legacyVercel.expectedResources[0].provider = "vercel";
  assert.throws(() => buildResourceControlReport(legacyVercel), /provider is invalid/);
});
