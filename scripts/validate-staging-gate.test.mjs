import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  digestCanonicalJson,
  deriveFinalDecision,
  validateScenarioRegistry,
  validateStagingGateBundle,
  validateStagingGateRecord
} from "./validate-staging-gate.mjs";

const registry = JSON.parse(readFileSync(new URL("../deploy/staging-release-scenarios.json", import.meta.url), "utf8"));
const now = new Date("2026-11-14T12:00:00.000Z");
const sha = "a".repeat(40);
const digest = (character) => character.repeat(64);
const attemptId = "stg_20261114_release_01";

function clone(value) {
  return structuredClone(value);
}

function workflow(runId, actor = "release-bot") {
  return {
    repository: "clementbowe14/Kapchi",
    workflowName: "staging-release-gate",
    runId,
    runAttempt: 1,
    actor,
    environment: "staging"
  };
}

function deployments() {
  return {
    storefront: {
      teamId: "team_kapchi",
      projectId: "prj_storefront",
      deploymentId: "dpl_storefront123",
      immutableUrl: "https://kapchi-storefront-abc.vercel.app/release",
      aliasUrl: "https://staging.kapchi.example/release",
      candidateSha: sha
    },
    api: {
      teamId: "team_kapchi",
      projectId: "prj_api",
      deploymentId: "dpl_api123",
      immutableUrl: "https://kapchi-api-abc.vercel.app/health",
      aliasUrl: "https://api-staging.kapchi.example/health",
      candidateSha: sha
    }
  };
}

function common(recordType, runId, actor = "release-bot") {
  return {
    recordVersion: 1,
    recordType,
    attemptId,
    registryVersion: 1,
    environment: "staging",
    candidateSha: sha,
    createdAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    workflow: workflow(runId, actor),
    deployments: deployments(),
    providerIdentityHashes: {
      database: digest("1"),
      stripe: digest("2"),
      clerk: digest("3"),
      blob: digest("4"),
      redis: digest("5"),
      messaging: digest("6")
    }
  };
}

function attestation(runId, subjectDigest) {
  return {
    issuer: "https://token.actions.githubusercontent.com",
    repository: "clementbowe14/Kapchi",
    workflowRunId: runId,
    subjectDigest,
    environment: "staging"
  };
}

function artifact(id, runId, character = "b") {
  const value = digest(character);
  return {
    id,
    downloadUrl: `https://github.com/clementbowe14/Kapchi/actions/runs/${runId}/artifacts/${id}`,
    sha256: value,
    mediaType: "application/json",
    sizeBytes: 512,
    createdAt: "2026-11-14T10:30:00.000Z",
    attestation: attestation(runId, value)
  };
}

function recordRef(id, runId, character) {
  const value = digest(character);
  return {
    artifactId: id,
    sha256: value,
    attestation: attestation(runId, value),
    attemptId,
    registryVersion: 1,
    candidateSha: sha,
    createdAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    storefrontDeploymentId: "dpl_storefront123",
    apiDeploymentId: "dpl_api123"
  };
}

function proof(mode, status, artifactIds, referenceIds = []) {
  return {
    mode,
    status,
    checkedAt: "2026-11-14T10:45:00.000Z",
    candidateSha: sha,
    storefrontDeploymentId: "dpl_storefront123",
    apiDeploymentId: "dpl_api123",
    evidenceArtifactIds: artifactIds,
    evidenceReferenceIds: referenceIds
  };
}

function preparedRecord() {
  const providerScenarios = registry.scenarios.filter(({ proofModes }) => proofModes.includes("provider"));
  return {
    ...common("prepared", 100),
    automatedEvidenceArtifacts: [
      artifact("candidate-report", 100, "b"),
      artifact("staging-report", 100, "c")
    ],
    providerObjectBindings: providerScenarios.map((scenario, index) => ({
      scenarioId: scenario.id,
      provider: providerFor(scenario.id)[0],
      objectHash: digest(((index + 1) % 10).toString())
    })),
    scenarioResults: registry.scenarios.map((scenario) => ({
      id: scenario.id,
      proofs: scenario.proofModes.map((mode) => mode === "provider"
        ? proof(mode, "pending", [])
        : proof(mode, "pass", [mode === "candidate" ? "candidate-report" : "staging-report"]))
    }))
  };
}

function providerFor(scenarioId) {
  if (scenarioId === "ASSET-UPLOAD-OWNERSHIP") return ["vercel", "https://vercel.com/kapchi/blob/object-1"];
  if (scenarioId === "MESSAGE-DELIVERY") return ["messaging", "https://github.com/clementbowe14/Kapchi/actions/runs/200"];
  if (scenarioId === "OBS-CORRELATION-REDACTION") return ["logs", "https://vercel.com/kapchi/logs/attempt-1"];
  return ["stripe", `https://dashboard.stripe.com/test/${scenarioId.toLowerCase()}`];
}

function manualRecord() {
  const providerScenarios = registry.scenarios.filter(({ proofModes }) => proofModes.includes("provider"));
  const references = providerScenarios.map((scenario, index) => {
    const [provider, url] = providerFor(scenario.id);
    return {
      id: `provider-ref-${index + 1}`,
      scenarioId: scenario.id,
      provider,
      url,
      observedAt: "2026-11-14T11:00:00.000Z",
      objectHash: digest(((index + 1) % 10).toString()),
      evidenceArtifactId: "provider-capture"
    };
  });
  return {
    ...common("manual", 200, "staging-reviewer"),
    preparedRecordRef: recordRef("prepared-record", 100, "d"),
    reviewer: {
      actor: "staging-reviewer",
      environment: "staging",
      approvedAt: "2026-11-14T11:05:00.000Z",
      workflowRunId: 200
    },
    externalEvidenceArtifacts: [artifact("provider-capture", 200, "e")],
    providerReferences: references,
    scenarioResults: providerScenarios.map((scenario, index) => ({
      id: scenario.id,
      proofs: [proof("provider", "pass", ["provider-capture"], [`provider-ref-${index + 1}`])]
    }))
  };
}

function cleanup(status = "pass") {
  const resources = [
    ["aliases", "deletable", "deleted"],
    ["database", "deletable", "deleted"],
    ["blob", "deletable", "deleted"],
    ["clerk", "deletable", "deleted"],
    ["stripe", "provider-retained", "terminal-isolated"],
    ["messaging", "provider-retained", "terminal-isolated"]
  ].map(([kind, retention, outcome], index) => ({
    kind,
    retention,
    outcome: status === "fail" && kind === "blob" ? "fail" : outcome,
    namespaceHash: digest(((index + 1) % 10).toString())
  }));
  return {
    status,
    verifiedAt: "2026-11-14T11:30:00.000Z",
    evidenceArtifact: artifact("cleanup-report", 300, "f"),
    resources
  };
}

function finalRecord() {
  const prepared = preparedRecord();
  const manual = manualRecord();
  const providerProofs = new Map(manual.scenarioResults.map((result) => [result.id, result.proofs[0]]));
  const record = {
    ...common("final", 300),
    preparedRecordRef: recordRef("prepared-record", 100, "d"),
    manualRecordRef: recordRef("manual-record", 200, "e"),
    scenarioResults: prepared.scenarioResults.map((result) => ({
      id: result.id,
      proofs: result.proofs.map((entry) => entry.mode === "provider" ? providerProofs.get(result.id) : entry)
    })),
    cleanup: cleanup(),
    blockers: [],
    finalizedAt: "2026-11-14T11:45:00.000Z",
    decision: {
      value: "GO",
      generatedAt: "2026-11-14T11:45:00.000Z",
      generatedBy: "scripts/validate-staging-gate.mjs",
      reasonCodes: ["ALL_REQUIRED_PROOFS_PASS"]
    }
  };
  return record;
}

function boundBundle() {
  const prepared = preparedRecord();
  const manual = manualRecord();
  const final = finalRecord();
  const preparedDigest = digestCanonicalJson(prepared);
  manual.preparedRecordRef.sha256 = preparedDigest;
  manual.preparedRecordRef.attestation.subjectDigest = preparedDigest;
  final.preparedRecordRef = clone(manual.preparedRecordRef);
  const manualDigest = digestCanonicalJson(manual);
  final.manualRecordRef.sha256 = manualDigest;
  final.manualRecordRef.attestation.subjectDigest = manualDigest;
  return { prepared, manual, final };
}

test("validates the stable registry and all three record phases", () => {
  assert.equal(validateScenarioRegistry(registry).scenarioCount, 25);
  assert.equal(validateStagingGateRecord(preparedRecord(), registry, { now }).recordType, "prepared");
  assert.equal(validateStagingGateRecord(manualRecord(), registry, { now }).recordType, "manual");
  assert.equal(validateStagingGateRecord(finalRecord(), registry, { now }).decision, "GO");
  assert.equal(validateStagingGateBundle(boundBundle(), registry, { now }).decision, "GO");
});

test("rejects an unknown scenario", () => {
  const record = preparedRecord();
  record.scenarioResults[0].id = "UNKNOWN-SCENARIO";
  assert.throws(() => validateStagingGateRecord(record, registry, { now }), /unknown scenario ID/);
});

test("rejects a missing scenario", () => {
  const record = preparedRecord();
  record.scenarioResults.pop();
  assert.throws(() => validateStagingGateRecord(record, registry, { now }), /exactly 25 scenarios/);
});

test("rejects duplicate scenarios and proof modes", () => {
  const record = preparedRecord();
  record.scenarioResults[1] = clone(record.scenarioResults[0]);
  assert.throws(() => validateStagingGateRecord(record, registry, { now }), /duplicate scenario ID/);

  const proofRecord = preparedRecord();
  const result = proofRecord.scenarioResults.find(({ id }) => id === "CART-GUEST-CRUD");
  result.proofs[1] = clone(result.proofs[0]);
  assert.throws(() => validateStagingGateRecord(proofRecord, registry, { now }), /duplicate candidate proof/);
});

test("rejects mixed SHA and deployment evidence", () => {
  const shaRecord = finalRecord();
  shaRecord.scenarioResults[0].proofs[0].candidateSha = "9".repeat(40);
  assert.throws(() => validateStagingGateRecord(shaRecord, registry, { now }), /candidateSha differs/);

  const deploymentRecord = manualRecord();
  deploymentRecord.preparedRecordRef.apiDeploymentId = "dpl_other456";
  assert.throws(() => validateStagingGateRecord(deploymentRecord, registry, { now }), /apiDeploymentId differs/);
});

test("rejects stale records and observations outside the attempt", () => {
  const stale = preparedRecord();
  assert.throws(
    () => validateStagingGateRecord(stale, registry, { now: new Date("2026-11-16T12:00:00.000Z") }),
    /record is stale/
  );

  const observation = manualRecord();
  observation.providerReferences[0].observedAt = "2026-11-13T09:00:00.000Z";
  assert.throws(() => validateStagingGateRecord(observation, registry, { now }), /predates the attempt/);

  const proof = preparedRecord();
  proof.scenarioResults[0].proofs[0].checkedAt = "2026-11-14T09:30:00.000Z";
  assert.throws(() => validateStagingGateRecord(proof, registry, { now }), /predates the attempt/);
});

test("rejects unapproved or unsafe provider references", () => {
  const host = manualRecord();
  host.providerReferences[0].url = "https://attacker.example/evidence/1";
  assert.throws(() => validateStagingGateRecord(host, registry, { now }), /host is not approved/);

  const query = manualRecord();
  query.providerReferences[0].url = "https://vercel.com/kapchi/blob/object-1?token=secret";
  assert.throws(() => validateStagingGateRecord(query, registry, { now }), /query string/);
});

test("rejects evidence assigned to another scenario", () => {
  const record = manualRecord();
  const first = record.scenarioResults[0];
  first.proofs[0].evidenceReferenceIds = [record.providerReferences[1].id];
  assert.throws(() => validateStagingGateRecord(record, registry, { now }), /evidence for another scenario/);
});

test("rejects invalid artifact digests and attestation metadata", () => {
  const digestRecord = preparedRecord();
  digestRecord.automatedEvidenceArtifacts[0].sha256 = "not-a-digest";
  assert.throws(() => validateStagingGateRecord(digestRecord, registry, { now }), /SHA-256 digest/);

  const attestationRecord = manualRecord();
  attestationRecord.externalEvidenceArtifacts[0].attestation.repository = "someone/else";
  assert.throws(() => validateStagingGateRecord(attestationRecord, registry, { now }), /repository differs/);
});

test("requires complete provider evidence with no pending result", () => {
  const missing = manualRecord();
  missing.scenarioResults.pop();
  assert.throws(() => validateStagingGateRecord(missing, registry, { now }), /exactly 7 scenarios/);

  const pending = manualRecord();
  pending.scenarioResults[0].proofs[0].status = "pending";
  assert.throws(() => validateStagingGateRecord(pending, registry, { now }), /cannot remain pending/);
});

test("blocks GO when cleanup fails", () => {
  const record = finalRecord();
  record.cleanup = cleanup("fail");
  assert.throws(() => validateStagingGateRecord(record, registry, { now }), /decision must be NO-GO/);
});

test("accepts generated NO-GO for failed cleanup", () => {
  const record = finalRecord();
  record.cleanup = cleanup("fail");
  record.blockers = ["Blob cleanup did not verify absence"];
  const expected = deriveFinalDecision(record);
  record.decision.value = expected.value;
  record.decision.reasonCodes = expected.reasonCodes;
  assert.equal(validateStagingGateRecord(record, registry, { now }).decision, "NO-GO");
});

test("rejects operator-authored or incorrectly generated decisions", () => {
  const operator = finalRecord();
  operator.decision.generatedBy = "staging-reviewer";
  assert.throws(() => validateStagingGateRecord(operator, registry, { now }), /trusted validator code/);

  const wrongReasons = finalRecord();
  wrongReasons.decision.reasonCodes = ["OPERATOR_APPROVED"];
  assert.throws(() => validateStagingGateRecord(wrongReasons, registry, { now }), /reasonCodes do not match/);
});

test("rejects a final proof that differs from its immutable source", () => {
  const { prepared, manual, final } = boundBundle();
  const proof = final.scenarioResults.find(({ id }) => id === "CHECKOUT-GUEST-SUCCESS").proofs.find(({ mode }) => mode === "provider");
  proof.checkedAt = "2026-11-14T11:15:00.000Z";
  assert.throws(
    () => validateStagingGateBundle({ prepared, manual, final }, registry, { now }),
    /differs from its immutable source/
  );
});

test("binds provider observations and record references to immutable source content", () => {
  const valid = boundBundle();
  assert.equal(validateStagingGateBundle(valid, registry, { now }).decision, "GO");

  const objectMismatch = boundBundle();
  objectMismatch.manual.providerReferences[0].objectHash = digest("f");
  const manualDigest = digestCanonicalJson(objectMismatch.manual);
  objectMismatch.final.manualRecordRef.sha256 = manualDigest;
  objectMismatch.final.manualRecordRef.attestation.subjectDigest = manualDigest;
  assert.throws(
    () => validateStagingGateBundle(objectMismatch, registry, { now }),
    /object differs from the prepared binding/
  );

  const digestMismatch = boundBundle();
  digestMismatch.final.manualRecordRef.sha256 = digest("0");
  digestMismatch.final.manualRecordRef.attestation.subjectDigest = digest("0");
  assert.throws(
    () => validateStagingGateBundle(digestMismatch, registry, { now }),
    /digest differs from the manual record/
  );
});

test("rejects duplicate IDs in the scenario registry", () => {
  const invalid = clone(registry);
  invalid.scenarios[1].id = invalid.scenarios[0].id;
  assert.throws(() => validateScenarioRegistry(invalid), /duplicate scenario ID/);
});
