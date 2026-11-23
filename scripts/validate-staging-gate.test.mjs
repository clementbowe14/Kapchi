import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildCandidateReport, runCandidateSuite } from "./staging-gate-evidence.mjs";
import { buildResourceControlReport, deterministicStagingNamespace } from "./staging-gate-control.mjs";
import { buildLogCanaryBundle, deriveLogScanReport, deriveProviderReport, deriveScenarioReport } from "./staging-gate-derived-evidence.mjs";
import {
  digestCanonicalJson,
  validateScenarioRegistry,
  validateStagingGateRecord,
  validateStagingGateV2Record
} from "./validate-staging-gate.mjs";

const registry = JSON.parse(readFileSync(new URL("../deploy/staging-release-scenarios.json", import.meta.url), "utf8"));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const candidateSha = "a".repeat(40);
const lockfileDigest = "b".repeat(64);
const attemptId = "stg_20261123_release_01";
const now = new Date("2026-11-23T12:00:00.000Z");
const gateWorkflow = {
  repository: "clementbowe14/Kapchi",
  workflowFile: ".github/workflows/staging-release-gate.yml",
  workflowSha: "c".repeat(40),
  runId: 500,
  runAttempt: 1,
  actor: "clementbowe14"
};
const candidateWorkflow = {
  repository: "clementbowe14/Kapchi",
  workflowFile: ".github/workflows/staging-release-candidate.yml",
  workflowSha: "d".repeat(40),
  runId: 400,
  runAttempt: 1,
  actor: "clementbowe14"
};

function hash(character) {
  return character.repeat(64);
}

function candidateOwners(suiteId) {
  const prefix = suiteId === "backend-tests" ? "backend/" : suiteId === "client-tests" ? "client/" : "scripts/";
  return [...new Set(registry.scenarios.flatMap(({ canonicalOwners }) => canonicalOwners)
    .filter((owner) => !owner.file.includes(".staging.spec.") && owner.file.startsWith(prefix))
    .flatMap(({ file, testIds }) => testIds.map((id) => JSON.stringify({ file, id }))))].sort().map(JSON.parse);
}

async function candidateReceipt(suite) {
  const owners = candidateOwners(suite.id);
  return runCandidateSuite({
    registry,
    suiteId: suite.id,
    repositoryRoot,
    candidateSha,
    workflow: candidateWorkflow,
    executeCommand: async () => {
      if (suite.resultFormat === "vitest-json") {
        const count = Math.max(1, owners.length);
        const byFile = new Map();
        for (const owner of owners) byFile.set(owner.file, [...(byFile.get(owner.file) ?? []), owner.id]);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            numTotalTestSuites: count,
            numTotalTests: count,
            numPassedTests: count,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [...byFile.entries()].map(([file, ids]) => ({ name: `${repositoryRoot}/${file}`, assertionResults: ids.map((title) => ({ title, status: "passed" })) }))
          }),
          stderr: ""
        };
      }
      if (suite.resultFormat === "node-test-tap") {
        return { exitCode: 0, signal: null, stdout: "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
    },
    now: () => new Date("2026-11-23T10:00:00.000Z")
  });
}

function artifactBinding(name, digest, workflow, artifactId) {
  return {
    artifactId,
    name: `staging-${name}-evidence`,
    archiveSha256: hash("a"),
    contentSha256: hash("b"),
    reportDigest: digest,
    repository: workflow.repository,
    workflowFile: workflow.workflowFile,
    workflowSha: workflow.workflowSha,
    runId: workflow.runId,
    runAttempt: workflow.runAttempt,
    candidateSha,
    createdAt: "2026-11-23T11:35:00.000Z",
    downloadUrl: `https://github.com/${workflow.repository}/actions/runs/${workflow.runId}/artifacts/${artifactId}`
  };
}

function artifactVerification(binding) {
  return {
    verificationVersion: 1,
    artifactId: binding.artifactId,
    name: binding.name,
    runId: binding.runId,
    runAttempt: binding.runAttempt,
    candidateSha: binding.candidateSha,
    archiveBytes: 100,
    archiveSha256: binding.archiveSha256,
    contentSha256: binding.contentSha256,
    files: ["report.json"]
  };
}

function artifactDigest(verification) {
  return {
    archiveBytes: verification.archiveBytes,
    archiveSha256: verification.archiveSha256,
    contentSha256: verification.contentSha256,
    files: verification.files
  };
}

async function fixture() {
  const receipts = await Promise.all(registry.candidateSuites.map(candidateReceipt));
  const candidateReport = buildCandidateReport({
    registry,
    receipts,
    candidateSha,
    lockfileDigest,
    workflow: candidateWorkflow,
    createdAt: "2026-11-23T10:05:00.000Z"
  });
  assert.equal(candidateReport.decision, "pass");
  const stagingObservations = registry.scenarios.filter(({ proofModes }) => proofModes.includes("staging")).flatMap((scenario) =>
    scenario.canonicalOwners.filter(({ file }) => file.includes(".staging.spec.")).flatMap(({ testIds }) => testIds.map((testId) => ({
      observationVersion: 1,
      scenarioId: scenario.id,
      testId,
      attemptId,
      candidateSha,
      startedAt: "2026-11-23T10:30:00.000Z",
      finishedAt: "2026-11-23T10:31:00.000Z",
      outcome: "passed",
      assertionIds: scenario.assertions.map((_, index) => `${scenario.id}:assertion:${index + 1}`)
    })))
  );
  const providerIdentityHashes = { database: hash("1"), stripe: hash("2"), clerk: hash("3"), blob: hash("4"), redis: hash("5"), messaging: hash("6"), vercel: hash("7"), logs: hash("8") };
  const providerObservations = registry.scenarios.filter(({ proofModes }) => proofModes.includes("provider")).flatMap((scenario) => scenario.providerObservations.map((proof) => ({
    observationVersion: 1,
    scenarioId: scenario.id,
    reportId: proof.id,
    attemptId,
    candidateSha,
    provider: proof.provider,
    windowStartedAt: "2026-11-23T10:40:00.000Z",
    observedAt: "2026-11-23T10:41:00.000Z",
    windowEndedAt: "2026-11-23T10:42:00.000Z",
    expectedIdentityHash: providerIdentityHashes[proof.provider],
    actualIdentityHash: providerIdentityHashes[proof.provider],
    expectedResourceHash: hash("8"),
    actualResourceHash: hash("8"),
    outcomeCode: "observed"
  })));
  const sanitizedLogInput = `${JSON.stringify({ event: "gate.observed", attemptId, candidateSha, requestId: "req_safe" })}\n`;
  const logCanaries = buildLogCanaryBundle({ attemptId, candidateSha });
  const stagingReport = deriveScenarioReport({ registry, observations: stagingObservations, attemptId, candidateSha, createdAt: "2026-11-23T11:00:00.000Z" });
  const providerReport = deriveProviderReport({ registry, observations: providerObservations, providerIdentityHashes, attemptId, candidateSha, createdAt: "2026-11-23T11:05:00.000Z" });
  const logReport = deriveLogScanReport({ input: sanitizedLogInput, attemptId, candidateSha, createdAt: "2026-11-23T11:10:00.000Z", logCanaries });
  const resourceNamespace = deterministicStagingNamespace(attemptId, candidateSha);
  const resourceExport = {
    exportVersion: 2,
    environment: "staging",
    attemptId,
    candidateSha,
    ownerTokenHash: hash("1"),
    productionDenylistHashes: [hash("f")],
    expectedResources: [{
      provider: "blob",
      namespace: resourceNamespace,
      idempotencyKeyHash: createHash("sha256").update(`${attemptId}:blob:one`).digest("hex"),
      expectedAccountHash: hash("2"),
      expectedProjectHash: hash("3")
    }],
    resources: [{
      provider: "blob",
      namespace: resourceNamespace,
      idempotencyKey: `${attemptId}:blob:one`,
      expectedAccountHash: hash("2"),
      expectedProjectHash: hash("3"),
      state: "cleaned",
      handleHash: hash("4"),
      intentRecordedAt: "2026-11-23T10:10:00.000Z",
      providerCallStartedAt: "2026-11-23T10:11:00.000Z",
      cleanupVerifiedAt: "2026-11-23T11:20:00.000Z",
      absenceVerified: true,
      terminalStateVerified: false
    }]
  };
  const resourceReport = buildResourceControlReport(resourceExport, { generatedAt: "2026-11-23T11:30:00.000Z" });
  const reportDigests = {
    candidate: digestCanonicalJson(candidateReport),
    staging: stagingReport.reportDigest,
    provider: providerReport.reportDigest,
    logScan: logReport.reportDigest,
    cleanup: resourceReport.reportDigest
  };
  const artifactBindings = {
    candidate: artifactBinding("candidate", reportDigests.candidate, candidateWorkflow, 1001),
    staging: artifactBinding("staging", reportDigests.staging, gateWorkflow, 1002),
    provider: artifactBinding("provider", reportDigests.provider, gateWorkflow, 1003),
    logScan: artifactBinding("log-scan", reportDigests.logScan, gateWorkflow, 1004),
    cleanup: artifactBinding("cleanup", reportDigests.cleanup, gateWorkflow, 1005)
  };
  const artifactVerifications = Object.fromEntries(Object.entries(artifactBindings).map(([name, binding]) => [name, artifactVerification(binding)]));
  const artifactDigests = Object.fromEntries(Object.entries(artifactVerifications).map(([name, verification]) => [name, artifactDigest(verification)]));
  const record = {
    recordVersion: 2,
    recordType: "final",
    trustMode: "single-owner-procedural",
    issue: 115,
    attemptId,
    environment: "staging",
    candidate: { sha: candidateSha, lockfileDigest, registryVersion: registry.registryVersion },
    createdAt: "2026-11-23T10:00:00.000Z",
    expiresAt: "2026-11-24T10:00:00.000Z",
    workflow: gateWorkflow,
    deploymentCredentials: { stagingIdentityHash: hash("a"), productionIdentityHash: hash("b") },
    deployments: {
      staging: {
        storefront: { projectId: "prj_storefront", deploymentId: "dpl_storefront123", sourceSha: candidateSha, immutableUrl: "https://kapchi-storefront-abc.vercel.app/release" },
        api: { projectId: "prj_api", deploymentId: "dpl_api123", sourceSha: candidateSha, immutableUrl: "https://kapchi-api-abc.vercel.app/health" }
      },
      productionPreflight: { productionBranch: "production", storefrontProjectId: "prj_storefront", apiProjectId: "prj_api", checkedAt: "2026-11-23T10:10:00.000Z" }
    },
    aliases: {
      siteDomain: "kapchi.co.uk",
      storefront: "https://staging.kapchi.co.uk",
      api: "https://api-staging.kapchi.co.uk",
      storefrontDeploymentId: "dpl_storefront123",
      apiDeploymentId: "dpl_api123",
      verifiedAt: "2026-11-23T11:40:00.000Z"
    },
    providerIdentityHashes,
    reportDigests,
    artifactBindings,
    scenarioResults: registry.scenarios.map((scenario) => ({
      id: scenario.id,
      candidate: scenario.proofModes.includes("candidate") ? "pass" : null,
      staging: scenario.proofModes.includes("staging") ? "pass" : null,
      provider: scenario.proofModes.includes("provider") ? "pass" : null
    })),
    evidenceStatus: { candidate: "pass", staging: "pass", provider: "pass", logScan: "pass", cleanup: "pass" },
    resourceControl: {
      reportDigest: resourceReport.reportDigest,
      status: resourceReport.status,
      resourceCount: resourceReport.resources.length,
      expectedResourceCount: resourceReport.expectedResourceCount,
      expectedResourceDigest: resourceReport.expectedResourceDigest
    },
    blockers: [],
    decision: { value: "GO", reasonCodes: [], derivedBy: "scripts/validate-staging-gate.mjs", finalizedAt: "2026-11-23T11:45:00.000Z" }
  };
  return {
    record,
    sources: { candidateReport, candidateReceipts: receipts, stagingReport, stagingObservations, providerReport, providerObservations, sanitizedLogInput, logCanaries, logScanReport: logReport, resourceReport, resourceExport, artifactVerifications, artifactDigests }
  };
}

test("validates the 25-scenario registry and exact owner files", () => {
  assert.equal(validateScenarioRegistry(registry).scenarioCount, 25);
  for (const scenario of registry.scenarios) {
    for (const owner of scenario.canonicalOwners) {
      assert.ok(existsSync(new URL(`../${owner.file}`, import.meta.url)), `${scenario.id} owner does not exist: ${owner.file}`);
    }
  }
});

test("validates a digest-bound single-owner procedural record", async () => {
  const { record, sources } = await fixture();
  assert.equal(validateStagingGateRecord(record, registry, { sources, now }).decision, "GO");
});

test("rejects the removed legacy record contract", async () => {
  const { record, sources } = await fixture();
  record.recordVersion = 1;
  assert.throws(() => validateStagingGateRecord(record, registry, { sources, now }), /only procedural staging gate recordVersion 2/);
});

test("rejects handwritten scenario status changes", async () => {
  const { record, sources } = await fixture();
  record.scenarioResults[0].candidate = "pending";
  assert.throws(() => validateStagingGateV2Record(record, registry, sources, { now }), /not derived from source reports/);
});

test("rejects artifact metadata that is not bound to its report and workflow", async () => {
  const digestMismatch = await fixture();
  digestMismatch.record.artifactBindings.candidate.reportDigest = hash("0");
  assert.throws(() => validateStagingGateV2Record(digestMismatch.record, registry, digestMismatch.sources, { now }), /differs from its report/);

  const workflowMismatch = await fixture();
  workflowMismatch.record.artifactBindings.provider.runId = 999;
  assert.throws(() => validateStagingGateV2Record(workflowMismatch.record, registry, workflowMismatch.sources, { now }), /differs from its workflow/);
});

test("rejects a fabricated verification receipt that does not match bundled artifact bytes", async () => {
  const fabricated = await fixture();
  fabricated.sources.artifactVerifications.provider.archiveSha256 = hash("9");
  fabricated.record.artifactBindings.provider.archiveSha256 = hash("9");
  assert.throws(
    () => validateStagingGateV2Record(fabricated.record, registry, fabricated.sources, { now }),
    /does not match the bundled archive and extracted contents/,
  );
});

test("requires distinct direct-sibling HTTPS aliases under a multi-label site", async () => {
  const nested = await fixture();
  nested.record.aliases.storefront = "https://nested.staging.kapchi.co.uk";
  assert.throws(() => validateStagingGateV2Record(nested.record, registry, nested.sources, { now }), /direct sibling/);

  const singleLabel = await fixture();
  singleLabel.record.aliases.siteDomain = "localhost";
  assert.throws(() => validateStagingGateV2Record(singleLabel.record, registry, singleLabel.sources, { now }), /multi-label DNS name/);

  const pathAlias = await fixture();
  pathAlias.record.aliases.api = "https://api-staging.kapchi.co.uk/path";
  assert.throws(() => validateStagingGateV2Record(pathAlias.record, registry, pathAlias.sources, { now }), /exact origin/);

  const portAlias = await fixture();
  portAlias.record.aliases.api = "https://api-staging.kapchi.co.uk:8443";
  assert.throws(() => validateStagingGateV2Record(portAlias.record, registry, portAlias.sources, { now }), /default HTTPS port/);
});

test("rejects shared staging and production deployment identities", async () => {
  const { record, sources } = await fixture();
  record.deploymentCredentials.productionIdentityHash = record.deploymentCredentials.stagingIdentityHash;
  assert.throws(() => validateStagingGateV2Record(record, registry, sources, { now }), /must differ/);
});

test("rejects stale records and altered log-scan content", async () => {
  const stale = await fixture();
  assert.throws(() => validateStagingGateV2Record(stale.record, registry, stale.sources, { now: new Date("2026-11-25T12:00:00.000Z") }), /stale/);

  const altered = await fixture();
  altered.sources.logScanReport.findings.push({ line: 1, code: "forged" });
  assert.throws(() => validateStagingGateV2Record(altered.record, registry, altered.sources, { now }), /not derived from sanitized log input/);
});
