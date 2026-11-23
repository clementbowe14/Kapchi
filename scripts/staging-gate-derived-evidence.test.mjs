import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLogCanaryBundle, deriveLogScanReport, deriveProviderReport, deriveScenarioReport } from "./staging-gate-derived-evidence.mjs";

const attemptId = "stg_review_12345";
const candidateSha = "a".repeat(40);
const logCanaries = buildLogCanaryBundle({ attemptId, candidateSha });
const hash = (character) => character.repeat(64);
const registry = {
  registryVersion: 3,
  scenarios: [{
    id: "FLOW-ONE",
    proofModes: ["staging", "provider"],
    canonicalOwners: [{ file: "client/e2e/flow.staging.spec.ts", testIds: ["[FLOW-ONE] executes the flow"] }],
    providerObservations: [{ id: "FLOW-ONE:stripe-session", provider: "stripe" }],
    assertions: ["first", "second"]
  }]
};

function scenarioObservation(overrides = {}) {
  return {
    observationVersion: 1,
    scenarioId: "FLOW-ONE",
    testId: "[FLOW-ONE] executes the flow",
    attemptId,
    candidateSha,
    startedAt: "2026-11-23T10:00:00.000Z",
    finishedAt: "2026-11-23T10:01:00.000Z",
    outcome: "passed",
    assertionIds: ["FLOW-ONE:assertion:1", "FLOW-ONE:assertion:2"],
    ...overrides
  };
}

function providerObservation(overrides = {}) {
  return {
    observationVersion: 1,
    scenarioId: "FLOW-ONE",
    reportId: "FLOW-ONE:stripe-session",
    attemptId,
    candidateSha,
    provider: "stripe",
    windowStartedAt: "2026-11-23T10:00:00.000Z",
    observedAt: "2026-11-23T10:01:00.000Z",
    windowEndedAt: "2026-11-23T10:02:00.000Z",
    expectedIdentityHash: hash("1"),
    actualIdentityHash: hash("1"),
    expectedResourceHash: hash("2"),
    actualResourceHash: hash("2"),
    outcomeCode: "observed",
    ...overrides
  };
}

test("derives staging status and rejects an unrelated test ID", () => {
  const report = deriveScenarioReport({ registry, observations: [scenarioObservation()], attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z" });
  assert.equal(report.status, "pass");
  assert.throws(
    () => deriveScenarioReport({ registry, observations: [scenarioObservation({ testId: "different test" })], attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z" }),
    /not a reviewed owner ID/
  );
});

test("keeps a staging scenario pending until every reviewed test ID passes", () => {
  const multiOwnerRegistry = structuredClone(registry);
  multiOwnerRegistry.scenarios[0].canonicalOwners[0].testIds.push("[FLOW-ONE] verifies cleanup");
  const pending = deriveScenarioReport({
    registry: multiOwnerRegistry,
    observations: [scenarioObservation()],
    attemptId,
    candidateSha,
    createdAt: "2026-11-23T10:03:00.000Z"
  });
  assert.equal(pending.status, "pending");

  const failed = deriveScenarioReport({
    registry: multiOwnerRegistry,
    observations: [
      scenarioObservation(),
      scenarioObservation({ testId: "[FLOW-ONE] verifies cleanup", outcome: "failed" })
    ],
    attemptId,
    candidateSha,
    createdAt: "2026-11-23T10:03:00.000Z"
  });
  assert.equal(failed.status, "fail");
});

test("derives provider failure from identity drift without a supplied status", () => {
  const report = deriveProviderReport({
    registry,
    observations: [providerObservation({ actualIdentityHash: hash("9") })],
    providerIdentityHashes: { stripe: hash("1") },
    attemptId,
    candidateSha,
    createdAt: "2026-11-23T10:03:00.000Z"
  });
  assert.equal(report.status, "fail");
  assert.equal(report.scenarioResults[0].status, "fail");
});

test("scans bounded sanitized logs for secrets and correlation", () => {
  const safe = `${JSON.stringify({ event: "safe", attemptId, candidateSha })}\n`;
  assert.equal(deriveLogScanReport({ input: safe, attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z", logCanaries }).status, "pass");
  const unsafe = `${safe}${JSON.stringify({ authorization: "Bearer secret-token" })}\n`;
  const report = deriveLogScanReport({ input: unsafe, attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z", logCanaries });
  assert.equal(report.status, "fail");
  assert.ok(report.findings.some(({ code }) => code === "authorization"));
});

test("recursively rejects customer and provider data keys", () => {
  const input = `${JSON.stringify({
    event: "unsafe",
    attemptId,
    candidateSha,
    nested: {
      shipping_address: { postal_code: "90210" },
      customization: [{ customizationText: "Class of 2027" }],
      upload: { original_file_name: "portrait.png" },
      provider: { rawPayload: { id: "evt_123" } }
    }
  })}\n`;
  const report = deriveLogScanReport({ input, attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z", logCanaries });
  const codes = new Set(report.findings.map(({ code }) => code));
  assert.equal(report.status, "fail");
  assert.ok(codes.has("forbidden-key:address"));
  assert.ok(codes.has("forbidden-key:customization-text"));
  assert.ok(codes.has("forbidden-key:filename"));
  assert.ok(codes.has("forbidden-key:provider-payload"));
});

test("rejects sensitive values, private blob URLs, query strings, and deterministic log canaries", () => {
  const canary = logCanaries.values[0].value;
  const input = `${JSON.stringify({
    event: "unsafe-values",
    attemptId,
    candidateSha,
    detail: "Ship to 44 Market Street",
    object: "customer-artwork.png",
    blob: "https://store-id.private.blob.vercel-storage.com/artwork.png?token=secret",
    marker: canary
  })}\n`;
  const report = deriveLogScanReport({
    input,
    attemptId,
    candidateSha,
    createdAt: "2026-11-23T10:03:00.000Z",
    logCanaries
  });
  const codes = new Set(report.findings.map(({ code }) => code));
  assert.ok(codes.has("address-value"));
  assert.ok(codes.has("filename-value"));
  assert.ok(codes.has("private-blob-url"));
  assert.ok(codes.has("url-query-string"));
  assert.ok(codes.has("log-canary"));
  assert.equal(report.canaryCount, 4);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(canary));
});

test("rejects arbitrary, stale, or sensitive canary configuration", () => {
  const input = `${JSON.stringify({ event: "safe", attemptId, candidateSha })}\n`;
  const arbitrary = structuredClone(logCanaries);
  arbitrary.values[0].value = "customer@example.com";
  assert.throws(
    () => deriveLogScanReport({ input, attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z", logCanaries: arbitrary }),
    /deterministic non-sensitive bundle/,
  );
  const stale = buildLogCanaryBundle({ attemptId, candidateSha: "b".repeat(40) });
  assert.throws(
    () => deriveLogScanReport({ input, attemptId, candidateSha, createdAt: "2026-11-23T10:03:00.000Z", logCanaries: stale }),
    /deterministic non-sensitive bundle/,
  );
});
