import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evidenceKeys, validateLaunchRecord } from "./validate-launch-record.mjs";
import { buildCandidateReport, runCandidateSuite } from "./staging-gate-evidence.mjs";
import { buildResourceControlReport, deterministicStagingNamespace } from "./staging-gate-control.mjs";
import { buildLogCanaryBundle, deriveLogScanReport, deriveProviderReport, deriveScenarioReport } from "./staging-gate-derived-evidence.mjs";
import { digestCanonicalJson, loadStagingGateBundle } from "./validate-staging-gate.mjs";
import { digestBundledArtifact } from "./verify-staging-artifact.mjs";

const now = new Date("2026-11-05T18:00:00.000Z");
const sha = "a".repeat(40);
const lockfileDigest = "b".repeat(64);
const stagingGateRegistry = JSON.parse(readFileSync(
  new URL("../deploy/staging-release-scenarios.json", import.meta.url),
  "utf8",
));

function options(stagingGateRecord = validStagingGateRecord(), overrides = {}) {
  return {
    now,
    stagingGateRecord,
    stagingGateRegistry,
    stagingGateSources: { completeBundle: true },
    stagingGateValidator: (gate, reviewedRegistry, validationOptions) => {
      assert.equal(reviewedRegistry, stagingGateRegistry);
      assert.deepEqual(validationOptions.sources, { completeBundle: true });
      return { decision: gate.decision.value };
    },
    ...overrides
  };
}

function validStagingGateRecord() {
  const reportDigests = {
    candidate: "1".repeat(64),
    staging: "2".repeat(64),
    provider: "3".repeat(64),
    logScan: "4".repeat(64),
    cleanup: "5".repeat(64)
  };
  return {
    recordVersion: 2,
    recordType: "final",
    trustMode: "single-owner-procedural",
    issue: 115,
    attemptId: "stg_launch_12345",
    candidate: { sha, lockfileDigest, registryVersion: stagingGateRegistry.registryVersion },
    expiresAt: "2026-11-06T17:00:00.000Z",
    deployments: {
      staging: {
        storefront: { deploymentId: "dpl_stagingclient123" },
        api: { deploymentId: "dpl_stagingbackend123" }
      }
    },
    reportDigests,
    scenarioResults: stagingGateRegistry.scenarios.map((scenario) => ({
      id: scenario.id,
      candidate: scenario.proofModes.includes("candidate") ? "pass" : null,
      staging: scenario.proofModes.includes("staging") ? "pass" : null,
      provider: scenario.proofModes.includes("provider") ? "pass" : null
    })),
    resourceControl: {
      status: "pass",
      reportDigest: reportDigests.cleanup,
      resourceCount: 1,
      expectedResourceCount: 1,
      expectedResourceDigest: "6".repeat(64)
    },
    blockers: [],
    decision: {
      value: "GO",
      reasonCodes: [],
      derivedBy: "scripts/validate-staging-gate.mjs",
      finalizedAt: "2026-11-05T16:45:00.000Z"
    }
  };
}

function validRecord(gate = validStagingGateRecord()) {
  const evidence = Object.fromEntries(evidenceKeys.map((key) => [key, {
    owner: `${key}-owner`,
    status: "pass",
    checkedAt: "2026-11-05T17:00:00.000Z",
    releaseSha: sha,
    references: [`https://evidence.kapchi.test/${key}`]
  }]));
  evidence.decision = {
    ...evidence.decision,
    value: "GO",
    signedBy: "release-owner",
    signedAt: "2026-11-05T17:45:00.000Z"
  };
  return {
    recordVersion: 1,
    release: {
      sha,
      lockfileDigest,
      registryVersion: gate.candidate.registryVersion,
      clientVercelDeploymentId: "dpl_client123",
      backendVercelDeploymentId: "dpl_backend123"
    },
    stagingGate: {
      issue: 115,
      recordVersion: 2,
      trustMode: "single-owner-procedural",
      attemptId: gate.attemptId,
      recordDigest: digestCanonicalJson(gate),
      candidateSha: sha,
      lockfileDigest,
      registryVersion: gate.candidate.registryVersion,
      stagingClientVercelDeploymentId: "dpl_stagingclient123",
      stagingBackendVercelDeploymentId: "dpl_stagingbackend123",
      decision: "GO",
      finalizedAt: gate.decision.finalizedAt,
      expiresAt: gate.expiresAt
    },
    domains: {
      client: "https://shop.kapchi.test",
      api: "https://api.kapchi.test"
    },
    owners: {
      release: "release-owner",
      database: "database-owner",
      payments: "payments-owner",
      auth: "auth-owner",
      messaging: "messaging-owner",
      incident: "incident-owner"
    },
    observationWindow: {
      startedAt: "2026-11-05T17:15:00.000Z",
      endedAt: "2026-11-05T17:30:00.000Z"
    },
    blockers: [],
    evidence
  };
}

function integrationRegistry() {
  return {
    registryVersion: 3,
    issue: 115,
    updatedAt: "2026-11-05T12:00:00.000Z",
    proofModes: ["candidate", "staging", "provider"],
    approvedEvidenceHosts: {
      stripe: ["api.stripe.com"],
      vercel: ["api.vercel.com"],
      clerk: ["api.clerk.com"],
      messaging: ["api.resend.com"],
      logs: ["api.vercel.com"]
    },
    candidateSuites: [{
      id: "repository-tests",
      workingDirectory: ".",
      command: ["node", "--test", "scripts/integration.test.mjs"],
      resultFormat: "vitest-json"
    }],
    scenarios: Array.from({ length: 25 }, (_, index) => {
      const id = `FLOW-${String(index + 1).padStart(3, "0")}`;
      return {
        id,
        title: `Integration scenario ${index + 1}`,
        proofModes: ["candidate", "staging", "provider"],
        canonicalOwners: [
          { file: "scripts/integration.test.mjs", testIds: [`candidate ${id}`] },
          { file: "client/e2e/integration.staging.spec.ts", testIds: [`staging ${id}`] }
        ],
        fixtures: ["integration-fixture"],
        assertions: ["the reviewed integration assertion passes"],
        providerObservations: [{ id: `${id}:stripe-observed`, provider: "stripe" }]
      };
    })
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function realStagingBundleFixture() {
  const registry = integrationRegistry();
  const attemptId = "stg_launch_integration_115";
  const workflow = {
    repository: "clementbowe14/Kapchi",
    workflowFile: ".github/workflows/staging-release-gate.yml",
    workflowSha: "c".repeat(40),
    runId: 500,
    runAttempt: 1,
    actor: "clementbowe14"
  };
  const candidateWorkflow = {
    ...workflow,
    workflowFile: ".github/workflows/staging-release-candidate.yml",
    workflowSha: "d".repeat(40),
    runId: 400
  };
  const candidateTests = registry.scenarios.map(({ id }) => ({
    file: "scripts/integration.test.mjs",
    id: `candidate ${id}`,
    status: "passed"
  }));
  const receipt = await runCandidateSuite({
    registry,
    suiteId: "repository-tests",
    repositoryRoot: process.cwd(),
    candidateSha: sha,
    workflow: candidateWorkflow,
    executeCommand: async () => ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        numTotalTestSuites: 1,
        numTotalTests: candidateTests.length,
        numPassedTests: candidateTests.length,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [{
          name: path.join(process.cwd(), "scripts/integration.test.mjs"),
          assertionResults: candidateTests.map(({ id, status }) => ({ title: id, status }))
        }]
      }),
      stderr: ""
    }),
    now: () => new Date("2026-11-05T13:00:00.000Z")
  });
  const candidateReport = buildCandidateReport({
    registry,
    receipts: [receipt],
    candidateSha: sha,
    lockfileDigest,
    workflow: candidateWorkflow,
    createdAt: "2026-11-05T13:05:00.000Z"
  });
  const stagingObservations = registry.scenarios.map((scenario) => ({
    observationVersion: 1,
    scenarioId: scenario.id,
    testId: `staging ${scenario.id}`,
    attemptId,
    candidateSha: sha,
    startedAt: "2026-11-05T13:10:00.000Z",
    finishedAt: "2026-11-05T13:11:00.000Z",
    outcome: "passed",
    assertionIds: [`${scenario.id}:assertion:1`]
  }));
  const providerIdentityHashes = {
    database: "1".repeat(64), stripe: "2".repeat(64), clerk: "3".repeat(64), blob: "4".repeat(64),
    redis: "5".repeat(64), messaging: "6".repeat(64), vercel: "7".repeat(64), logs: "8".repeat(64)
  };
  const providerObservations = registry.scenarios.map((scenario) => ({
    observationVersion: 1,
    scenarioId: scenario.id,
    reportId: `${scenario.id}:stripe-observed`,
    attemptId,
    candidateSha: sha,
    provider: "stripe",
    windowStartedAt: "2026-11-05T13:15:00.000Z",
    observedAt: "2026-11-05T13:16:00.000Z",
    windowEndedAt: "2026-11-05T13:17:00.000Z",
    expectedIdentityHash: providerIdentityHashes.stripe,
    actualIdentityHash: providerIdentityHashes.stripe,
    expectedResourceHash: "9".repeat(64),
    actualResourceHash: "9".repeat(64),
    outcomeCode: "observed"
  }));
  const stagingReport = deriveScenarioReport({ registry, observations: stagingObservations, attemptId, candidateSha: sha, createdAt: "2026-11-05T13:20:00.000Z" });
  const providerReport = deriveProviderReport({ registry, observations: providerObservations, providerIdentityHashes, attemptId, candidateSha: sha, createdAt: "2026-11-05T13:25:00.000Z" });
  const sanitizedLogInput = `${JSON.stringify({ event: "gate.observed", attemptId, candidateSha: sha })}\n`;
  const logCanaries = buildLogCanaryBundle({ attemptId, candidateSha: sha });
  const logScanReport = deriveLogScanReport({ input: sanitizedLogInput, attemptId, candidateSha: sha, createdAt: "2026-11-05T13:30:00.000Z", logCanaries });
  const resourceNamespace = deterministicStagingNamespace(attemptId, sha);
  const resourceExport = {
    exportVersion: 2,
    environment: "staging",
    attemptId,
    candidateSha: sha,
    ownerTokenHash: "a".repeat(64),
    productionDenylistHashes: ["f".repeat(64)],
    expectedResources: [{
      provider: "blob",
      namespace: resourceNamespace,
      idempotencyKeyHash: createHash("sha256").update(`${attemptId}:blob:launch-fixture`).digest("hex"),
      expectedAccountHash: "c".repeat(64),
      expectedProjectHash: "d".repeat(64)
    }],
    resources: [{
      provider: "blob",
      namespace: resourceNamespace,
      idempotencyKey: `${attemptId}:blob:launch-fixture`,
      expectedAccountHash: "c".repeat(64),
      expectedProjectHash: "d".repeat(64),
      state: "cleaned",
      handleHash: "e".repeat(64),
      intentRecordedAt: "2026-11-05T13:00:00.000Z",
      providerCallStartedAt: "2026-11-05T13:01:00.000Z",
      cleanupVerifiedAt: "2026-11-05T13:34:00.000Z",
      absenceVerified: true,
      terminalStateVerified: false
    }]
  };
  const resourceReport = buildResourceControlReport(resourceExport, { generatedAt: "2026-11-05T13:35:00.000Z" });
  const reportDigests = {
    candidate: digestCanonicalJson(candidateReport),
    staging: stagingReport.reportDigest,
    provider: providerReport.reportDigest,
    logScan: logScanReport.reportDigest,
    cleanup: resourceReport.reportDigest
  };
  const root = await mkdtemp(path.join(tmpdir(), "kapchi-launch-bundle-"));
  const artifactVerifications = {};
  const artifactBindings = {};
  for (const [index, name] of ["candidate", "staging", "provider", "logScan", "cleanup"].entries()) {
    const artifactRoot = path.join(root, "artifacts", name);
    await mkdir(path.join(artifactRoot, "contents"), { recursive: true });
    await writeFile(path.join(artifactRoot, "archive.zip"), `archive:${name}`);
    await writeJson(path.join(artifactRoot, "contents", "report.json"), { name, digest: reportDigests[name] });
    const digests = await digestBundledArtifact({ archivePath: path.join(artifactRoot, "archive.zip"), contentsDirectory: path.join(artifactRoot, "contents") });
    const artifactWorkflow = name === "candidate" ? candidateWorkflow : workflow;
    const binding = {
      artifactId: 1001 + index,
      name: `staging-${name}-evidence`,
      archiveSha256: digests.archiveSha256,
      contentSha256: digests.contentSha256,
      reportDigest: reportDigests[name],
      repository: artifactWorkflow.repository,
      workflowFile: artifactWorkflow.workflowFile,
      workflowSha: artifactWorkflow.workflowSha,
      runId: artifactWorkflow.runId,
      runAttempt: artifactWorkflow.runAttempt,
      candidateSha: sha,
      createdAt: "2026-11-05T13:40:00.000Z",
      downloadUrl: `https://github.com/${artifactWorkflow.repository}/actions/runs/${artifactWorkflow.runId}/artifacts/${1001 + index}`
    };
    artifactBindings[name] = binding;
    artifactVerifications[name] = {
      verificationVersion: 1,
      artifactId: binding.artifactId,
      name: binding.name,
      runId: binding.runId,
      runAttempt: binding.runAttempt,
      candidateSha: sha,
      ...digests
    };
  }
  const record = {
    recordVersion: 2,
    recordType: "final",
    trustMode: "single-owner-procedural",
    issue: 115,
    attemptId,
    environment: "staging",
    candidate: { sha, lockfileDigest, registryVersion: registry.registryVersion },
    createdAt: "2026-11-05T13:00:00.000Z",
    expiresAt: "2026-11-06T13:00:00.000Z",
    workflow,
    deploymentCredentials: { stagingIdentityHash: "a".repeat(64), productionIdentityHash: "b".repeat(64) },
    deployments: {
      staging: {
        storefront: { projectId: "prj_storefront", deploymentId: "dpl_stagingclient123", sourceSha: sha, immutableUrl: "https://kapchi-storefront.vercel.app/release" },
        api: { projectId: "prj_api", deploymentId: "dpl_stagingbackend123", sourceSha: sha, immutableUrl: "https://kapchi-api.vercel.app/health" }
      },
      productionPreflight: { productionBranch: "production", storefrontProjectId: "prj_storefront", apiProjectId: "prj_api", checkedAt: "2026-11-05T13:42:00.000Z" }
    },
    aliases: {
      siteDomain: "kapchi.test",
      storefront: "https://staging.kapchi.test",
      api: "https://api-staging.kapchi.test",
      storefrontDeploymentId: "dpl_stagingclient123",
      apiDeploymentId: "dpl_stagingbackend123",
      verifiedAt: "2026-11-05T13:43:00.000Z"
    },
    providerIdentityHashes,
    reportDigests,
    artifactBindings,
    scenarioResults: registry.scenarios.map(({ id }) => ({ id, candidate: "pass", staging: "pass", provider: "pass" })),
    evidenceStatus: { candidate: "pass", staging: "pass", provider: "pass", logScan: "pass", cleanup: "pass" },
    resourceControl: {
      reportDigest: resourceReport.reportDigest,
      status: "pass",
      resourceCount: resourceReport.resources.length,
      expectedResourceCount: resourceReport.expectedResourceCount,
      expectedResourceDigest: resourceReport.expectedResourceDigest
    },
    blockers: [],
    decision: { value: "GO", reasonCodes: [], derivedBy: "scripts/validate-staging-gate.mjs", finalizedAt: "2026-11-05T13:45:00.000Z" }
  };
  await mkdir(path.join(root, "logs"), { recursive: true });
  await Promise.all([
    writeJson(path.join(root, "record.json"), record),
    writeJson(path.join(root, "candidate", "report.json"), candidateReport),
    writeJson(path.join(root, "candidate", "receipts", "repository-tests.json"), receipt),
    writeJson(path.join(root, "staging", "report.json"), stagingReport),
    writeJson(path.join(root, "staging", "observations.json"), stagingObservations),
    writeJson(path.join(root, "provider", "report.json"), providerReport),
    writeJson(path.join(root, "provider", "observations.json"), providerObservations),
    writeFile(path.join(root, "logs", "sanitized.ndjson"), sanitizedLogInput),
    writeJson(path.join(root, "logs", "canaries.json"), logCanaries),
    writeJson(path.join(root, "logs", "report.json"), logScanReport),
    writeJson(path.join(root, "cleanup", "report.json"), resourceReport),
    writeJson(path.join(root, "cleanup", "export.json"), resourceExport),
    writeJson(path.join(root, "artifacts", "verifications.json"), artifactVerifications)
  ]);
  return { root, registry, record };
}

test("accepts a complete and consistent GO record", () => {
  assert.equal(validateLaunchRecord(validRecord(), options()).decision, "GO");
});

test("validates a launch record through the real on-disk staging bundle and default validator", async () => {
  const fixture = await realStagingBundleFixture();
  const bundle = await loadStagingGateBundle(fixture.root);
  const launchRecord = validRecord(bundle.record);
  assert.equal(validateLaunchRecord(launchRecord, {
    now,
    stagingGateRecord: bundle.record,
    stagingGateRegistry: fixture.registry,
    stagingGateSources: bundle.sources
  }).decision, "GO");
});

test("rejects fabricated artifact verification JSON even when the final record matches it", async () => {
  const fixture = await realStagingBundleFixture();
  const verificationPath = path.join(fixture.root, "artifacts", "verifications.json");
  const verifications = JSON.parse(await readFile(verificationPath, "utf8"));
  const forgedDigest = "0".repeat(64);
  verifications.provider.archiveSha256 = forgedDigest;
  fixture.record.artifactBindings.provider.archiveSha256 = forgedDigest;
  await Promise.all([
    writeJson(verificationPath, verifications),
    writeJson(path.join(fixture.root, "record.json"), fixture.record)
  ]);
  const bundle = await loadStagingGateBundle(fixture.root);
  assert.throws(
    () => validateLaunchRecord(validRecord(bundle.record), {
      now,
      stagingGateRecord: bundle.record,
      stagingGateRegistry: fixture.registry,
      stagingGateSources: bundle.sources
    }),
    /does not match the bundled archive and extracted contents/,
  );
});

test("propagates complete staging bundle validation failures", () => {
  const validationOptions = options(validStagingGateRecord(), {
    stagingGateValidator: () => { throw new Error("raw provider observation mismatch"); }
  });
  assert.throws(() => validateLaunchRecord(validRecord(), validationOptions), /raw provider observation mismatch/);
});

test("rejects GO when one check is pending", () => {
  const record = validRecord();
  record.evidence.blob.status = "pending";
  assert.throws(() => validateLaunchRecord(record, options()), /GO requires blob to pass/);
});

test("rejects release identity drift", () => {
  const record = validRecord();
  record.evidence.migration.releaseSha = "c".repeat(40);
  assert.throws(() => validateLaunchRecord(record, options()), /differs from the release/);
});

test("rejects stale restore evidence", () => {
  const record = validRecord();
  record.evidence.restoreDrill.checkedAt = "2026-09-01T00:00:00.000Z";
  assert.throws(() => validateLaunchRecord(record, options()), /restoreDrill evidence is stale/);
});

test("accepts a truthful NO-GO record with a blocker", () => {
  const record = validRecord();
  record.blockers = ["messaging canary did not deliver"];
  record.evidence.messaging.status = "fail";
  record.evidence.decision.value = "NO-GO";
  assert.equal(validateLaunchRecord(record, options()).decision, "NO-GO");
});

test("rejects production GO without the final issue #115 record", () => {
  assert.throws(() => validateLaunchRecord(validRecord(), { now }), /final issue #115 staging gate record is required/);
});

test("rejects a mismatched or stale issue #115 record", () => {
  const changed = validStagingGateRecord();
  changed.candidate.sha = "c".repeat(40);
  assert.throws(() => validateLaunchRecord(validRecord(), options(changed)), /candidate differs/);

  assert.throws(
    () => validateLaunchRecord(validRecord(), options(validStagingGateRecord(), { now: new Date("2026-11-07T00:00:00.000Z") })),
    /stale/
  );
});

test("rejects production deployment IDs reused from staging", () => {
  const record = validRecord();
  record.release.clientVercelDeploymentId = record.stagingGate.stagingClientVercelDeploymentId;
  assert.throws(() => validateLaunchRecord(record, options()), /must differ from staging/);
});

test("rejects unregistered scenarios and missing required proof modes", () => {
  const unknownScenario = validStagingGateRecord();
  unknownScenario.scenarioResults[0].id = "UNREGISTERED-SCENARIO";
  assert.throws(
    () => validateLaunchRecord(validRecord(), options(unknownScenario)),
    /scenarios or required proof modes differ/,
  );

  const missingProof = validStagingGateRecord();
  const required = stagingGateRegistry.scenarios.findIndex(({ proofModes }) => proofModes.includes("staging"));
  missingProof.scenarioResults[required].staging = null;
  assert.throws(
    () => validateLaunchRecord(validRecord(), options(missingProof)),
    /scenarios or required proof modes differ/,
  );
});

test("rejects a launch record with a different finalization time", () => {
  const gate = validStagingGateRecord();
  gate.decision.finalizedAt = "2026-11-05T16:46:00.000Z";
  assert.throws(
    () => validateLaunchRecord(validRecord(), options(gate)),
    /finalization time differs/,
  );
});
