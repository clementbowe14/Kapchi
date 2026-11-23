#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  digestCanonicalJson,
  loadStagingGateBundle,
  validateScenarioRegistry,
  validateStagingGateRecord
} from "./validate-staging-gate.mjs";

export const evidenceKeys = [
  "topology",
  "secrets",
  "migration",
  "health",
  "auth",
  "stripe",
  "blob",
  "messaging",
  "backup",
  "restoreDrill",
  "rollbackRehearsal",
  "alerts",
  "smoke",
  "observation",
  "decision"
];
const ownerKeys = ["release", "database", "payments", "auth", "messaging", "incident"];
const statuses = new Set(["pass", "fail", "pending"]);
const providerReference = /^(?:https:\/\/|vercel:\/\/|stripe:\/\/|clerk:\/\/|betterstack:\/\/)/;
const placeholderPattern = /(?:PLACEHOLDER|REPLACE_ME|EXAMPLE|TBD|OWNER_NAME|EVIDENCE_URL|000000)/i;

function validDate(value, label) {
  const timestamp = Date.parse(value);
  assert.ok(Number.isFinite(timestamp), `${label} must be an ISO timestamp`);
  return timestamp;
}

function assertNotPlaceholder(value, label) {
  assert.ok(!placeholderPattern.test(String(value)), `${label} is still a placeholder`);
}

function registrableSuffix(hostname) {
  return hostname.split(".").slice(-2).join(".");
}

export function validateLaunchRecord(
  record,
  { now = new Date(), template = false, stagingGateRecord, stagingGateRegistry, stagingGateSources, stagingGateValidator = validateStagingGateRecord } = {},
) {
  assert.equal(record.recordVersion, 1, "recordVersion must be 1");
  assert.match(record.release?.sha ?? "", /^[0-9a-f]{40}$/i, "release.sha must be a full Git SHA");
  if (!template) {
    assert.match(record.release?.lockfileDigest ?? "", /^[0-9a-f]{64}$/, "release.lockfileDigest must be SHA-256");
    assert.ok(Number.isSafeInteger(record.release?.registryVersion) && record.release.registryVersion > 0, "release.registryVersion must be positive");
  }
  if (template) {
    assert.ok(String(record.release?.clientVercelDeploymentId ?? "").trim(), "client Vercel deployment ID is required");
    assert.ok(String(record.release?.backendVercelDeploymentId ?? "").trim(), "backend Vercel deployment ID is required");
  } else {
    assert.match(record.release?.clientVercelDeploymentId ?? "", /^dpl_[A-Za-z0-9]+$/, "client Vercel deployment ID is invalid");
    assert.match(record.release?.backendVercelDeploymentId ?? "", /^dpl_[A-Za-z0-9]+$/, "backend Vercel deployment ID is invalid");
  }
  assert.notEqual(record.release.clientVercelDeploymentId, record.release.backendVercelDeploymentId, "client and backend must use distinct Vercel deployments");

  if (!template) {
    assert.equal(record.stagingGate?.issue, 115, "stagingGate.issue must be 115");
    assert.equal(record.stagingGate?.recordVersion, 2, "stagingGate.recordVersion must be 2");
    assert.equal(record.stagingGate?.trustMode, "single-owner-procedural", "stagingGate.trustMode is invalid");
    assert.match(record.stagingGate?.attemptId ?? "", /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/, "stagingGate.attemptId is invalid");
    assert.match(record.stagingGate?.recordDigest ?? "", /^[0-9a-f]{64}$/, "stagingGate.recordDigest must be SHA-256");
    assert.match(record.stagingGate?.candidateSha ?? "", /^[0-9a-f]{40}$/, "stagingGate.candidateSha is invalid");
    assert.match(record.stagingGate?.lockfileDigest ?? "", /^[0-9a-f]{64}$/, "stagingGate.lockfileDigest is invalid");
    assert.ok(Number.isSafeInteger(record.stagingGate?.registryVersion) && record.stagingGate.registryVersion > 0, "stagingGate.registryVersion must be positive");
    assert.equal(record.stagingGate.candidateSha, record.release.sha, "staging gate candidate differs from the release");
    assert.equal(record.stagingGate.lockfileDigest, record.release.lockfileDigest, "staging gate lockfile differs from the release");
    assert.equal(record.stagingGate.registryVersion, record.release.registryVersion, "staging gate registry differs from the release");
    assert.match(record.stagingGate.stagingClientVercelDeploymentId ?? "", /^dpl_[A-Za-z0-9]+$/, "staging client deployment ID is invalid");
    assert.match(record.stagingGate.stagingBackendVercelDeploymentId ?? "", /^dpl_[A-Za-z0-9]+$/, "staging backend deployment ID is invalid");
    assert.notEqual(record.stagingGate.stagingClientVercelDeploymentId, record.release.clientVercelDeploymentId, "production client deployment must differ from staging");
    assert.notEqual(record.stagingGate.stagingBackendVercelDeploymentId, record.release.backendVercelDeploymentId, "production backend deployment must differ from staging");
    assert.equal(record.stagingGate.decision, "GO", "staging gate decision must be GO");
    validDate(record.stagingGate.finalizedAt, "stagingGate.finalizedAt");
    const stagingExpiresAt = validDate(record.stagingGate.expiresAt, "stagingGate.expiresAt");
    assert.ok(stagingGateRecord, "the final issue #115 staging gate record is required");
    assert.ok(stagingGateRegistry, "the reviewed issue #115 scenario registry is required");
    assert.ok(stagingGateSources, "the complete issue #115 staging evidence bundle is required");
    validateScenarioRegistry(stagingGateRegistry);
    const stagingValidation = stagingGateValidator(stagingGateRecord, stagingGateRegistry, { now, sources: stagingGateSources });
    assert.equal(stagingValidation.decision, "GO", "the complete issue #115 evidence bundle did not produce GO");
    assert.equal(stagingGateRegistry.registryVersion, record.release.registryVersion, "issue #115 registry version differs from the release");
    assert.equal(stagingGateRecord.recordVersion, 2, "issue #115 recordVersion must be 2");
    assert.equal(stagingGateRecord.recordType, "final", "issue #115 record must be final");
    assert.equal(stagingGateRecord.trustMode, "single-owner-procedural", "issue #115 trust mode is invalid");
    assert.equal(stagingGateRecord.issue, 115, "issue #115 record has the wrong issue");
    assert.equal(stagingGateRecord.attemptId, record.stagingGate.attemptId, "issue #115 attempt differs");
    assert.equal(stagingGateRecord.candidate?.sha, record.release.sha, "issue #115 candidate differs");
    assert.equal(stagingGateRecord.candidate?.lockfileDigest, record.release.lockfileDigest, "issue #115 lockfile differs");
    assert.equal(stagingGateRecord.candidate?.registryVersion, record.release.registryVersion, "issue #115 registry differs");
    assert.equal(stagingGateRecord.decision?.value, "GO", "issue #115 final decision must be GO");
    assert.equal(stagingGateRecord.decision?.derivedBy, "scripts/validate-staging-gate.mjs", "issue #115 decision was not validator-derived");
    assert.deepEqual(stagingGateRecord.decision?.reasonCodes, [], "issue #115 GO must not contain reason codes");
    assert.ok(Array.isArray(stagingGateRecord.scenarioResults), "issue #115 scenario results are required");
    const expectedScenarioResults = stagingGateRegistry.scenarios.map((scenario) => ({
      id: scenario.id,
      candidate: scenario.proofModes.includes("candidate") ? "pass" : null,
      staging: scenario.proofModes.includes("staging") ? "pass" : null,
      provider: scenario.proofModes.includes("provider") ? "pass" : null
    }));
    assert.deepEqual(
      stagingGateRecord.scenarioResults,
      expectedScenarioResults,
      "issue #115 scenarios or required proof modes differ from the reviewed registry",
    );
    for (const name of ["candidate", "staging", "provider", "logScan", "cleanup"]) {
      assert.match(stagingGateRecord.reportDigests?.[name] ?? "", /^[0-9a-f]{64}$/, `issue #115 ${name} report digest is invalid`);
    }
    assert.equal(stagingGateRecord.resourceControl?.status, "pass", "issue #115 cleanup must be verified");
    assert.equal(stagingGateRecord.resourceControl?.reportDigest, stagingGateRecord.reportDigests.cleanup, "issue #115 cleanup digest differs");
    assert.ok(Number.isSafeInteger(stagingGateRecord.resourceControl?.resourceCount) && stagingGateRecord.resourceControl.resourceCount >= 0, "issue #115 resource count is invalid");
    assert.equal(stagingGateRecord.blockers?.length, 0, "issue #115 record has blockers");
    assert.equal(stagingGateRecord.deployments?.staging?.storefront?.deploymentId, record.stagingGate.stagingClientVercelDeploymentId, "issue #115 storefront deployment differs");
    assert.equal(stagingGateRecord.deployments?.staging?.api?.deploymentId, record.stagingGate.stagingBackendVercelDeploymentId, "issue #115 API deployment differs");
    assert.equal(stagingGateRecord.expiresAt, record.stagingGate.expiresAt, "issue #115 expiry differs");
    assert.equal(stagingGateRecord.decision?.finalizedAt, record.stagingGate.finalizedAt, "issue #115 finalization time differs");
    assert.equal(digestCanonicalJson(stagingGateRecord), record.stagingGate.recordDigest, "issue #115 record digest differs");
    assert.ok(now.getTime() <= stagingExpiresAt, "issue #115 staging gate record is stale");
  }

  for (const key of ownerKeys) {
    assert.ok(String(record.owners?.[key] ?? "").trim(), `owners.${key} is required`);
    if (!template) assertNotPlaceholder(record.owners[key], `owners.${key}`);
  }

  const client = new URL(record.domains?.client ?? "");
  const api = new URL(record.domains?.api ?? "");
  assert.equal(client.protocol, "https:", "client domain must use HTTPS");
  assert.equal(api.protocol, "https:", "API domain must use HTTPS");
  assert.notEqual(client.origin, api.origin, "client and API origins must be distinct");
  assert.equal(registrableSuffix(client.hostname), registrableSuffix(api.hostname), "client and API must be same-site custom domains");

  assert.ok(record.evidence && typeof record.evidence === "object", "evidence object is required");
  assert.deepEqual(Object.keys(record.evidence).sort(), [...evidenceKeys].sort(), "evidence keys must exactly match the contract");
  const nowMs = now.getTime();
  for (const key of evidenceKeys) {
    const item = record.evidence[key];
    assert.ok(String(item.owner ?? "").trim(), `${key}.owner is required`);
    assert.ok(statuses.has(item.status), `${key}.status must be pass, fail, or pending`);
    assert.equal(item.releaseSha, record.release.sha, `${key}.releaseSha differs from the release`);
    const checkedAt = validDate(item.checkedAt, `${key}.checkedAt`);
    assert.ok(checkedAt <= nowMs + 5 * 60 * 1000, `${key}.checkedAt is in the future`);
    assert.ok(Array.isArray(item.references) && item.references.length > 0, `${key}.references are required`);
    for (const reference of item.references) {
      assert.match(reference, providerReference, `${key} has an invalid evidence reference`);
      if (!template) assertNotPlaceholder(reference, `${key} evidence reference`);
    }
    if (!template) {
      assertNotPlaceholder(item.owner, `${key}.owner`);
      const maxAgeDays = key === "restoreDrill" ? 30 : 7;
      assert.ok(nowMs - checkedAt <= maxAgeDays * 24 * 60 * 60 * 1000, `${key} evidence is stale`);
    }
  }

  const observationStart = validDate(record.observationWindow?.startedAt, "observationWindow.startedAt");
  const observationEnd = validDate(record.observationWindow?.endedAt, "observationWindow.endedAt");
  assert.ok(observationEnd >= observationStart, "observation window ends before it starts");
  assert.ok(Array.isArray(record.blockers), "blockers must be an array");

  const decision = record.evidence.decision;
  assert.ok(["GO", "NO-GO"].includes(decision.value), "decision.value must be GO or NO-GO");
  assert.ok(String(decision.signedBy ?? "").trim(), "decision.signedBy is required");
  validDate(decision.signedAt, "decision.signedAt");
  if (!template) {
    assertNotPlaceholder(decision.signedBy, "decision.signedBy");
    assert.ok(Date.parse(decision.signedAt) >= observationEnd, "decision must be signed after observation ends");
  }

  if (decision.value === "GO") {
    assert.equal(record.blockers.length, 0, "GO is forbidden while blockers remain");
    for (const key of evidenceKeys) {
      assert.equal(record.evidence[key].status, "pass", `GO requires ${key} to pass`);
    }
  } else {
    assert.ok(
      record.blockers.length > 0 || Object.values(record.evidence).some((item) => item.status !== "pass"),
      "NO-GO must identify a blocker or non-passing check",
    );
  }

  return { decision: decision.value, evidenceCount: evidenceKeys.length, releaseSha: record.release.sha };
}

function parseArgs(argv) {
  const recordIndex = argv.indexOf("--record");
  if (recordIndex < 0 || !argv[recordIndex + 1]) throw new Error("Use --record <path>");
  const stagingGateIndex = argv.indexOf("--staging-gate-bundle");
  const stagingGateRegistryIndex = argv.indexOf("--staging-gate-registry");
  return {
    recordPath: argv[recordIndex + 1],
    template: argv.includes("--template"),
    stagingGateBundlePath: stagingGateIndex >= 0 ? argv[stagingGateIndex + 1] : undefined,
    stagingGateRegistryPath: stagingGateRegistryIndex >= 0 ? argv[stagingGateRegistryIndex + 1] : undefined
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = JSON.parse(await readFile(args.recordPath, "utf8"));
  const stagingBundle = args.stagingGateBundlePath ? await loadStagingGateBundle(args.stagingGateBundlePath) : undefined;
  const stagingGateRegistry = args.stagingGateRegistryPath
    ? JSON.parse(await readFile(args.stagingGateRegistryPath, "utf8"))
    : undefined;
  const result = validateLaunchRecord(record, {
    template: args.template,
    stagingGateRecord: stagingBundle?.record,
    stagingGateRegistry,
    stagingGateSources: stagingBundle?.sources
  });
  console.log(JSON.stringify({ event: "launch.record.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "launch.record.invalid", errorCode: "LAUNCH_RECORD_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
