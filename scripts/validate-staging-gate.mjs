#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const RECORD_VERSION = 1;
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const PROOF_STATUSES = new Set(["pass", "fail", "pending"]);
const PROVIDER_NAMES = new Set(["stripe", "vercel", "clerk", "messaging", "logs"]);
const COMMON_KEYS = [
  "recordVersion",
  "recordType",
  "attemptId",
  "registryVersion",
  "environment",
  "candidateSha",
  "createdAt",
  "expiresAt",
  "workflow",
  "deployments",
  "providerIdentityHashes"
];
const CLEANUP_RESOURCES = new Map([
  ["aliases", ["deletable", "deleted"]],
  ["database", ["deletable", "deleted"]],
  ["blob", ["deletable", "deleted"]],
  ["clerk", ["deletable", "deleted"]],
  ["stripe", ["provider-retained", "terminal-isolated"]],
  ["messaging", ["provider-retained", "terminal-isolated"]]
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestCanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys do not match the contract`);
}

function nonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim(), `${label} is required`);
  return value;
}

function stringArray(value, label, { nonEmpty = true } = {}) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  if (nonEmpty) assert.ok(value.length > 0, `${label} must not be empty`);
  value.forEach((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  assert.equal(new Set(value).size, value.length, `${label} contains duplicates`);
  return value;
}

function timestamp(value, label) {
  nonEmptyString(value, label);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} must be an ISO timestamp`);
  assert.equal(new Date(parsed).toISOString(), value, `${label} must use canonical ISO format`);
  return parsed;
}

function fullSha(value, label) {
  assert.match(value ?? "", GIT_SHA, `${label} must be a full lowercase Git SHA`);
}

function sha256(value, label) {
  assert.match(value ?? "", SHA256, `${label} must be a lowercase SHA-256 digest`);
}

function safeHttpsUrl(value, label, approvedHosts) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS`);
  assert.equal(url.username, "", `${label} must not contain credentials`);
  assert.equal(url.password, "", `${label} must not contain credentials`);
  assert.equal(url.search, "", `${label} must not contain a query string`);
  assert.equal(url.hash, "", `${label} must not contain a fragment`);
  assert.ok(url.pathname && url.pathname !== "/", `${label} must identify a specific resource`);
  if (approvedHosts) {
    assert.ok(approvedHosts.includes(url.hostname), `${label} host is not approved`);
  }
  return url;
}

function validateAttestation(value, label, expected) {
  exactKeys(value, ["issuer", "repository", "workflowRunId", "subjectDigest", "environment"], label);
  assert.equal(value.issuer, "https://token.actions.githubusercontent.com", `${label}.issuer is not trusted`);
  assert.equal(value.repository, expected.repository, `${label}.repository differs from the workflow repository`);
  assert.ok(Number.isSafeInteger(value.workflowRunId) && value.workflowRunId > 0, `${label}.workflowRunId must be a positive integer`);
  assert.equal(value.workflowRunId, expected.workflowRunId, `${label}.workflowRunId differs from the workflow run`);
  assert.equal(value.environment, "staging", `${label}.environment must be staging`);
  sha256(value.subjectDigest, `${label}.subjectDigest`);
  assert.equal(value.subjectDigest, expected.digest, `${label}.subjectDigest differs from the artifact digest`);
}

function validateArtifact(value, label, context) {
  exactKeys(value, ["id", "downloadUrl", "sha256", "mediaType", "sizeBytes", "createdAt", "attestation"], label);
  assert.match(value.id ?? "", IDENTIFIER, `${label}.id is invalid`);
  safeHttpsUrl(value.downloadUrl, `${label}.downloadUrl`, ["github.com"]);
  sha256(value.sha256, `${label}.sha256`);
  nonEmptyString(value.mediaType, `${label}.mediaType`);
  assert.ok(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0, `${label}.sizeBytes must be a positive integer`);
  const createdAt = timestamp(value.createdAt, `${label}.createdAt`);
  assert.ok(createdAt <= context.nowMs + CLOCK_SKEW_MS, `${label}.createdAt is in the future`);
  validateAttestation(value.attestation, `${label}.attestation`, {
    repository: context.repository,
    workflowRunId: context.workflowRunId,
    digest: value.sha256
  });
}

function validateArtifactRef(value, label, context) {
  exactKeys(value, [
    "artifactId",
    "sha256",
    "attestation",
    "attemptId",
    "registryVersion",
    "candidateSha",
    "createdAt",
    "expiresAt",
    "storefrontDeploymentId",
    "apiDeploymentId"
  ], label);
  assert.match(value.artifactId ?? "", IDENTIFIER, `${label}.artifactId is invalid`);
  sha256(value.sha256, `${label}.sha256`);
  assert.equal(value.attemptId, context.attemptId, `${label}.attemptId differs from the record`);
  assert.equal(value.registryVersion, context.registryVersion, `${label}.registryVersion differs from the record`);
  assert.equal(value.candidateSha, context.candidateSha, `${label}.candidateSha differs from the record`);
  assert.equal(value.createdAt, context.recordCreatedAt, `${label}.createdAt differs from the record`);
  assert.equal(value.expiresAt, context.recordExpiresAt, `${label}.expiresAt differs from the record`);
  assert.equal(value.storefrontDeploymentId, context.storefrontDeploymentId, `${label}.storefrontDeploymentId differs from the record`);
  assert.equal(value.apiDeploymentId, context.apiDeploymentId, `${label}.apiDeploymentId differs from the record`);
  validateAttestation(value.attestation, `${label}.attestation`, {
    repository: context.repository,
    workflowRunId: value.attestation?.workflowRunId,
    digest: value.sha256
  });
}

function validateDeployment(value, label, candidateSha) {
  exactKeys(value, ["teamId", "projectId", "deploymentId", "immutableUrl", "aliasUrl", "candidateSha"], label);
  assert.match(value.teamId ?? "", IDENTIFIER, `${label}.teamId is invalid`);
  assert.match(value.projectId ?? "", IDENTIFIER, `${label}.projectId is invalid`);
  assert.match(value.deploymentId ?? "", DEPLOYMENT_ID, `${label}.deploymentId is invalid`);
  const immutable = safeHttpsUrl(value.immutableUrl, `${label}.immutableUrl`);
  assert.ok(immutable.hostname.endsWith(".vercel.app"), `${label}.immutableUrl must be a Vercel deployment URL`);
  const alias = safeHttpsUrl(value.aliasUrl, `${label}.aliasUrl`);
  assert.notEqual(alias.origin, immutable.origin, `${label}.aliasUrl must be distinct from the immutable URL`);
  fullSha(value.candidateSha, `${label}.candidateSha`);
  assert.equal(value.candidateSha, candidateSha, `${label}.candidateSha differs from the record`);
}

function validateWorkflow(value, label) {
  exactKeys(value, ["repository", "workflowName", "runId", "runAttempt", "actor", "environment"], label);
  assert.match(value.repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `${label}.repository is invalid`);
  nonEmptyString(value.workflowName, `${label}.workflowName`);
  assert.ok(Number.isSafeInteger(value.runId) && value.runId > 0, `${label}.runId must be a positive integer`);
  assert.ok(Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0, `${label}.runAttempt must be a positive integer`);
  assert.match(value.actor ?? "", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, `${label}.actor is invalid`);
  assert.equal(value.environment, "staging", `${label}.environment must be staging`);
}

function validateCommon(record, registry, now) {
  assert.equal(record.recordVersion, RECORD_VERSION, `recordVersion must be ${RECORD_VERSION}`);
  assert.match(record.attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.equal(record.registryVersion, registry.registryVersion, "registryVersion does not match the scenario registry");
  assert.equal(record.environment, "staging", "environment must be staging");
  fullSha(record.candidateSha, "candidateSha");
  const createdAt = timestamp(record.createdAt, "createdAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  const nowMs = now.getTime();
  assert.ok(createdAt <= nowMs + CLOCK_SKEW_MS, "createdAt is in the future");
  assert.ok(expiresAt > createdAt, "expiresAt must be after createdAt");
  assert.ok(expiresAt - createdAt <= MAX_FRESHNESS_MS, "record freshness window may not exceed 24 hours");
  assert.ok(nowMs <= expiresAt + CLOCK_SKEW_MS, "record is stale");
  validateWorkflow(record.workflow, "workflow");
  exactKeys(record.deployments, ["storefront", "api"], "deployments");
  validateDeployment(record.deployments.storefront, "deployments.storefront", record.candidateSha);
  validateDeployment(record.deployments.api, "deployments.api", record.candidateSha);
  assert.notEqual(record.deployments.storefront.deploymentId, record.deployments.api.deploymentId, "storefront and API deployment IDs must differ");
  assert.notEqual(record.deployments.storefront.projectId, record.deployments.api.projectId, "storefront and API project IDs must differ");
  exactKeys(record.providerIdentityHashes, ["database", "stripe", "clerk", "blob", "redis", "messaging"], "providerIdentityHashes");
  for (const [provider, digest] of Object.entries(record.providerIdentityHashes)) {
    sha256(digest, `providerIdentityHashes.${provider}`);
  }
  return {
    nowMs,
    createdAt,
    expiresAt,
    recordCreatedAt: record.createdAt,
    recordExpiresAt: record.expiresAt,
    attemptStartedAt: createdAt,
    repository: record.workflow.repository,
    workflowRunId: record.workflow.runId,
    attemptId: record.attemptId,
    registryVersion: record.registryVersion,
    candidateSha: record.candidateSha,
    storefrontDeploymentId: record.deployments.storefront.deploymentId,
    apiDeploymentId: record.deployments.api.deploymentId
  };
}

function validateProof(proof, label, scenario, context, phase, artifactIds, referenceIds) {
  exactKeys(proof, [
    "mode",
    "status",
    "checkedAt",
    "candidateSha",
    "storefrontDeploymentId",
    "apiDeploymentId",
    "evidenceArtifactIds",
    "evidenceReferenceIds"
  ], label);
  assert.ok(scenario.proofModes.includes(proof.mode), `${label}.mode is not required by ${scenario.id}`);
  assert.ok(PROOF_STATUSES.has(proof.status), `${label}.status is invalid`);
  const checkedAt = timestamp(proof.checkedAt, `${label}.checkedAt`);
  assert.ok(checkedAt <= context.nowMs + CLOCK_SKEW_MS, `${label}.checkedAt is in the future`);
  assert.ok(checkedAt >= context.attemptStartedAt - CLOCK_SKEW_MS, `${label}.checkedAt predates the attempt`);
  assert.equal(proof.candidateSha, context.candidateSha, `${label}.candidateSha differs from the record`);
  assert.equal(proof.storefrontDeploymentId, context.storefrontDeploymentId, `${label}.storefrontDeploymentId differs from the record`);
  assert.equal(proof.apiDeploymentId, context.apiDeploymentId, `${label}.apiDeploymentId differs from the record`);
  stringArray(proof.evidenceArtifactIds, `${label}.evidenceArtifactIds`, { nonEmpty: phase !== "prepared" || proof.mode !== "provider" });
  stringArray(proof.evidenceReferenceIds, `${label}.evidenceReferenceIds`, {
    nonEmpty: phase === "manual" || (phase === "final" && proof.mode === "provider")
  });
  if (phase !== "final") {
    for (const id of proof.evidenceArtifactIds) assert.ok(artifactIds.has(id), `${label} references unknown evidence artifact ${id}`);
    for (const id of proof.evidenceReferenceIds) {
      assert.ok(referenceIds.has(id), `${label} references unknown provider evidence ${id}`);
      assert.equal(referenceIds.get(id), scenario.id, `${label} uses provider evidence for another scenario`);
    }
  }

  if (phase === "prepared") {
    if (proof.mode === "provider") {
      assert.equal(proof.status, "pending", `${label} provider proof must be pending during prepare`);
      assert.equal(proof.evidenceArtifactIds.length, 0, `${label} provider proof cannot have prepare evidence`);
      assert.equal(proof.evidenceReferenceIds.length, 0, `${label} provider proof cannot have prepare references`);
    } else {
      assert.notEqual(proof.status, "pending", `${label} deterministic proof cannot remain pending after prepare`);
      assert.equal(proof.evidenceReferenceIds.length, 0, `${label} deterministic proof cannot use provider references`);
    }
  } else if (phase === "manual") {
    assert.equal(proof.mode, "provider", `${label} manual records may contain provider proof only`);
    assert.notEqual(proof.status, "pending", `${label} provider proof cannot remain pending after evidence recording`);
  } else {
    assert.notEqual(proof.status, "pending", `${label} final proof cannot remain pending`);
    if (proof.mode !== "provider") {
      assert.equal(proof.evidenceReferenceIds.length, 0, `${label} deterministic proof cannot use provider references`);
    }
  }
}

function validateScenarioResults(results, registry, context, phase, artifactIds = new Set(), referenceIds = new Map()) {
  assert.ok(Array.isArray(results), "scenarioResults must be an array");
  const scenarios = new Map(registry.scenarios.map((scenario) => [scenario.id, scenario]));
  const expectedScenarios = phase === "manual"
    ? registry.scenarios.filter((scenario) => scenario.proofModes.includes("provider"))
    : registry.scenarios;
  assert.equal(results.length, expectedScenarios.length, `scenarioResults must contain exactly ${expectedScenarios.length} scenarios`);
  const seen = new Set();
  for (const [index, result] of results.entries()) {
    exactKeys(result, ["id", "proofs"], `scenarioResults[${index}]`);
    assert.ok(scenarios.has(result.id), `unknown scenario ID ${result.id}`);
    assert.ok(!seen.has(result.id), `duplicate scenario ID ${result.id}`);
    seen.add(result.id);
    const scenario = scenarios.get(result.id);
    const expectedModes = phase === "manual" ? ["provider"] : scenario.proofModes;
    assert.ok(Array.isArray(result.proofs), `${result.id}.proofs must be an array`);
    assert.equal(result.proofs.length, expectedModes.length, `${result.id} proof count does not match the registry`);
    const seenModes = new Set();
    result.proofs.forEach((proof, proofIndex) => {
      validateProof(proof, `${result.id}.proofs[${proofIndex}]`, scenario, context, phase, artifactIds, referenceIds);
      assert.ok(!seenModes.has(proof.mode), `${result.id} has duplicate ${proof.mode} proof`);
      seenModes.add(proof.mode);
    });
    assert.deepEqual([...seenModes].sort(), [...expectedModes].sort(), `${result.id} proof modes do not match the registry`);
  }
  assert.deepEqual([...seen].sort(), expectedScenarios.map(({ id }) => id).sort(), "scenarioResults are incomplete");
}

function validatePrepared(record, registry, context) {
  exactKeys(record, [...COMMON_KEYS, "scenarioResults", "automatedEvidenceArtifacts", "providerObjectBindings"], "prepared record");
  assert.ok(Array.isArray(record.automatedEvidenceArtifacts) && record.automatedEvidenceArtifacts.length > 0, "automatedEvidenceArtifacts must not be empty");
  const ids = new Set();
  record.automatedEvidenceArtifacts.forEach((artifact, index) => {
    validateArtifact(artifact, `automatedEvidenceArtifacts[${index}]`, context);
    assert.ok(!ids.has(artifact.id), `duplicate artifact ID ${artifact.id}`);
    ids.add(artifact.id);
  });
  validateScenarioResults(record.scenarioResults, registry, context, "prepared", ids);
  const usedArtifactIds = new Set(record.scenarioResults.flatMap(({ proofs }) => proofs.flatMap(({ evidenceArtifactIds }) => evidenceArtifactIds)));
  assert.deepEqual([...usedArtifactIds].sort(), [...ids].sort(), "automatedEvidenceArtifacts contains unused artifacts");

  const providerScenarios = registry.scenarios.filter(({ proofModes }) => proofModes.includes("provider"));
  assert.ok(Array.isArray(record.providerObjectBindings), "providerObjectBindings must be an array");
  assert.equal(record.providerObjectBindings.length, providerScenarios.length, "providerObjectBindings must cover every provider scenario");
  const seenBindings = new Set();
  for (const [index, binding] of record.providerObjectBindings.entries()) {
    exactKeys(binding, ["scenarioId", "provider", "objectHash"], `providerObjectBindings[${index}]`);
    assert.ok(providerScenarios.some(({ id }) => id === binding.scenarioId), `providerObjectBindings[${index}].scenarioId is not a provider scenario`);
    assert.ok(!seenBindings.has(binding.scenarioId), `duplicate provider object binding for ${binding.scenarioId}`);
    assert.ok(PROVIDER_NAMES.has(binding.provider), `providerObjectBindings[${index}].provider is invalid`);
    assert.ok(registry.approvedEvidenceHosts[binding.provider], `providerObjectBindings[${index}].provider has no approved hosts`);
    sha256(binding.objectHash, `providerObjectBindings[${index}].objectHash`);
    seenBindings.add(binding.scenarioId);
  }
  assert.deepEqual([...seenBindings].sort(), providerScenarios.map(({ id }) => id).sort(), "providerObjectBindings are incomplete");
}

function validateProviderReference(reference, label, registry, context, artifactIds, providerScenarioIds) {
  exactKeys(reference, ["id", "scenarioId", "provider", "url", "observedAt", "objectHash", "evidenceArtifactId"], label);
  assert.match(reference.id ?? "", IDENTIFIER, `${label}.id is invalid`);
  assert.ok(providerScenarioIds.has(reference.scenarioId), `${label}.scenarioId is not a provider scenario`);
  assert.ok(PROVIDER_NAMES.has(reference.provider), `${label}.provider is invalid`);
  const approvedHosts = registry.approvedEvidenceHosts[reference.provider];
  assert.ok(approvedHosts, `${label}.provider has no approved hosts`);
  safeHttpsUrl(reference.url, `${label}.url`, approvedHosts);
  const observedAt = timestamp(reference.observedAt, `${label}.observedAt`);
  assert.ok(observedAt >= context.attemptStartedAt - CLOCK_SKEW_MS, `${label}.observedAt predates the attempt`);
  assert.ok(observedAt <= context.nowMs + CLOCK_SKEW_MS, `${label}.observedAt is in the future`);
  sha256(reference.objectHash, `${label}.objectHash`);
  assert.ok(artifactIds.has(reference.evidenceArtifactId), `${label} references unknown evidence artifact ${reference.evidenceArtifactId}`);
}

function validateManual(record, registry, context) {
  exactKeys(record, [...COMMON_KEYS, "preparedRecordRef", "reviewer", "scenarioResults", "providerReferences", "externalEvidenceArtifacts"], "manual record");
  validateArtifactRef(record.preparedRecordRef, "preparedRecordRef", context);
  exactKeys(record.reviewer, ["actor", "environment", "approvedAt", "workflowRunId"], "reviewer");
  assert.equal(record.reviewer.actor, record.workflow.actor, "reviewer.actor must come from the authenticated workflow actor");
  assert.equal(record.reviewer.environment, "staging", "reviewer.environment must be staging");
  assert.equal(record.reviewer.workflowRunId, record.workflow.runId, "reviewer.workflowRunId differs from the workflow run");
  const approvedAt = timestamp(record.reviewer.approvedAt, "reviewer.approvedAt");
  assert.ok(approvedAt >= context.createdAt - CLOCK_SKEW_MS, "reviewer approval predates the evidence record");
  assert.ok(approvedAt <= context.nowMs + CLOCK_SKEW_MS, "reviewer approval is in the future");

  assert.ok(Array.isArray(record.externalEvidenceArtifacts) && record.externalEvidenceArtifacts.length > 0, "externalEvidenceArtifacts must not be empty");
  const artifactIds = new Set();
  record.externalEvidenceArtifacts.forEach((artifact, index) => {
    validateArtifact(artifact, `externalEvidenceArtifacts[${index}]`, context);
    assert.ok(!artifactIds.has(artifact.id), `duplicate artifact ID ${artifact.id}`);
    artifactIds.add(artifact.id);
  });
  assert.ok(Array.isArray(record.providerReferences) && record.providerReferences.length > 0, "providerReferences must not be empty");
  const referenceIds = new Map();
  const providerScenarioIds = new Set(registry.scenarios.filter(({ proofModes }) => proofModes.includes("provider")).map(({ id }) => id));
  record.providerReferences.forEach((reference, index) => {
    validateProviderReference(reference, `providerReferences[${index}]`, registry, context, artifactIds, providerScenarioIds);
    assert.ok(!referenceIds.has(reference.id), `duplicate provider reference ID ${reference.id}`);
    referenceIds.set(reference.id, reference.scenarioId);
  });
  validateScenarioResults(record.scenarioResults, registry, context, "manual", artifactIds, referenceIds);
  const usedArtifactIds = new Set(record.scenarioResults.flatMap(({ proofs }) => proofs.flatMap(({ evidenceArtifactIds }) => evidenceArtifactIds)));
  const usedReferenceIds = new Set(record.scenarioResults.flatMap(({ proofs }) => proofs.flatMap(({ evidenceReferenceIds }) => evidenceReferenceIds)));
  assert.deepEqual([...usedArtifactIds].sort(), [...artifactIds].sort(), "externalEvidenceArtifacts contains unused artifacts");
  assert.deepEqual([...usedReferenceIds].sort(), [...referenceIds.keys()].sort(), "providerReferences contains unused references");
}

function validateCleanup(cleanup, context) {
  exactKeys(cleanup, ["status", "verifiedAt", "evidenceArtifact", "resources"], "cleanup");
  assert.ok(["pass", "fail"].includes(cleanup.status), "cleanup.status must be pass or fail");
  const verifiedAt = timestamp(cleanup.verifiedAt, "cleanup.verifiedAt");
  assert.ok(verifiedAt >= context.attemptStartedAt - CLOCK_SKEW_MS, "cleanup.verifiedAt predates the attempt");
  assert.ok(verifiedAt <= context.nowMs + CLOCK_SKEW_MS, "cleanup.verifiedAt is in the future");
  validateArtifact(cleanup.evidenceArtifact, "cleanup.evidenceArtifact", context);
  assert.ok(Array.isArray(cleanup.resources), "cleanup.resources must be an array");
  assert.equal(cleanup.resources.length, CLEANUP_RESOURCES.size, "cleanup.resources must cover every required resource");
  const seen = new Set();
  let allClean = true;
  cleanup.resources.forEach((resource, index) => {
    exactKeys(resource, ["kind", "retention", "outcome", "namespaceHash"], `cleanup.resources[${index}]`);
    assert.ok(CLEANUP_RESOURCES.has(resource.kind), `cleanup resource ${resource.kind} is unknown`);
    assert.ok(!seen.has(resource.kind), `duplicate cleanup resource ${resource.kind}`);
    seen.add(resource.kind);
    const [retention, outcome] = CLEANUP_RESOURCES.get(resource.kind);
    assert.equal(resource.retention, retention, `${resource.kind} retention is invalid`);
    assert.ok([outcome, "fail"].includes(resource.outcome), `${resource.kind} outcome is invalid`);
    sha256(resource.namespaceHash, `${resource.kind}.namespaceHash`);
    if (resource.outcome !== outcome) allClean = false;
  });
  assert.deepEqual([...seen].sort(), [...CLEANUP_RESOURCES.keys()].sort(), "cleanup.resources are incomplete");
  assert.equal(cleanup.status, allClean ? "pass" : "fail", "cleanup.status does not match resource outcomes");
  return allClean;
}

export function deriveFinalDecision(record) {
  const failedProofs = record.scenarioResults.flatMap((scenario) =>
    scenario.proofs.filter(({ status }) => status !== "pass").map(({ mode, status }) => `SCENARIO_${status.toUpperCase()}:${scenario.id}:${mode}`)
  );
  const reasons = [...failedProofs];
  if (record.cleanup.status !== "pass") reasons.push("CLEANUP_NOT_VERIFIED");
  if (record.blockers.length > 0) reasons.push("BLOCKERS_REMAIN");
  return {
    value: reasons.length === 0 ? "GO" : "NO-GO",
    reasonCodes: reasons.length === 0 ? ["ALL_REQUIRED_PROOFS_PASS"] : [...new Set(reasons)].sort()
  };
}

function validateFinal(record, registry, context) {
  exactKeys(record, [...COMMON_KEYS, "preparedRecordRef", "manualRecordRef", "scenarioResults", "cleanup", "blockers", "finalizedAt", "decision"], "final record");
  validateArtifactRef(record.preparedRecordRef, "preparedRecordRef", context);
  validateArtifactRef(record.manualRecordRef, "manualRecordRef", context);
  assert.notEqual(record.preparedRecordRef.artifactId, record.manualRecordRef.artifactId, "prepared and manual records must be distinct artifacts");
  validateScenarioResults(record.scenarioResults, registry, context, "final", new Set(), new Map());
  const cleanupPasses = validateCleanup(record.cleanup, context);
  stringArray(record.blockers, "blockers", { nonEmpty: false });
  const finalizedAt = timestamp(record.finalizedAt, "finalizedAt");
  assert.ok(finalizedAt >= Date.parse(record.cleanup.verifiedAt), "finalizedAt must follow cleanup verification");
  assert.ok(finalizedAt <= context.expiresAt, "finalizedAt exceeds the freshness window");
  assert.ok(finalizedAt <= context.nowMs + CLOCK_SKEW_MS, "finalizedAt is in the future");
  exactKeys(record.decision, ["value", "generatedAt", "generatedBy", "reasonCodes"], "decision");
  assert.equal(record.decision.generatedBy, "scripts/validate-staging-gate.mjs", "decision must be generated by trusted validator code");
  assert.equal(record.decision.generatedAt, record.finalizedAt, "decision.generatedAt must equal finalizedAt");
  stringArray(record.decision.reasonCodes, "decision.reasonCodes");
  const expected = deriveFinalDecision(record);
  assert.equal(record.decision.value, expected.value, `decision must be ${expected.value}`);
  assert.deepEqual([...record.decision.reasonCodes].sort(), [...expected.reasonCodes].sort(), "decision.reasonCodes do not match the gate state");
  if (record.decision.value === "GO") {
    assert.ok(cleanupPasses, "GO requires verified cleanup");
    assert.equal(record.blockers.length, 0, "GO is forbidden while blockers remain");
  }
}

export function validateScenarioRegistry(registry) {
  exactKeys(registry, ["registryVersion", "issue", "updatedAt", "proofModes", "approvedEvidenceHosts", "scenarios"], "scenario registry");
  assert.ok(Number.isSafeInteger(registry.registryVersion) && registry.registryVersion > 0, "registryVersion must be a positive integer");
  assert.equal(registry.issue, 115, "registry issue must be 115");
  timestamp(registry.updatedAt, "registry.updatedAt");
  assert.deepEqual(registry.proofModes, ["candidate", "staging", "provider"], "registry proofModes are invalid");
  exactKeys(registry.approvedEvidenceHosts, [...PROVIDER_NAMES], "approvedEvidenceHosts");
  for (const [provider, hosts] of Object.entries(registry.approvedEvidenceHosts)) {
    stringArray(hosts, `approvedEvidenceHosts.${provider}`);
    hosts.forEach((host) => {
      assert.equal(new URL(`https://${host}`).hostname, host, `approvedEvidenceHosts.${provider} contains an invalid host`);
      assert.ok(!host.startsWith("*."), `approvedEvidenceHosts.${provider} must use exact hosts`);
    });
  }
  assert.ok(Array.isArray(registry.scenarios) && registry.scenarios.length > 0, "scenarios must not be empty");
  const ids = new Set();
  registry.scenarios.forEach((scenario, index) => {
    const label = `scenarios[${index}]`;
    exactKeys(scenario, ["id", "title", "proofModes", "canonicalOwners", "fixtures", "assertions"], label);
    assert.match(scenario.id ?? "", /^[A-Z][A-Z0-9-]{2,63}$/, `${label}.id is invalid`);
    assert.ok(!ids.has(scenario.id), `duplicate scenario ID ${scenario.id}`);
    ids.add(scenario.id);
    nonEmptyString(scenario.title, `${label}.title`);
    stringArray(scenario.proofModes, `${label}.proofModes`);
    scenario.proofModes.forEach((mode) => assert.ok(registry.proofModes.includes(mode), `${scenario.id} uses unknown proof mode ${mode}`));
    stringArray(scenario.canonicalOwners, `${label}.canonicalOwners`);
    stringArray(scenario.fixtures, `${label}.fixtures`);
    stringArray(scenario.assertions, `${label}.assertions`);
  });
  return { registryVersion: registry.registryVersion, scenarioCount: registry.scenarios.length };
}

export function validateStagingGateRecord(record, registry, { now = new Date() } = {}) {
  validateScenarioRegistry(registry);
  object(record, "record");
  assert.ok(["prepared", "manual", "final"].includes(record.recordType), "recordType must be prepared, manual, or final");
  const expectedKeys = record.recordType === "prepared"
    ? [...COMMON_KEYS, "scenarioResults", "automatedEvidenceArtifacts", "providerObjectBindings"]
    : record.recordType === "manual"
      ? [...COMMON_KEYS, "preparedRecordRef", "reviewer", "scenarioResults", "providerReferences", "externalEvidenceArtifacts"]
      : [...COMMON_KEYS, "preparedRecordRef", "manualRecordRef", "scenarioResults", "cleanup", "blockers", "finalizedAt", "decision"];
  exactKeys(record, expectedKeys, "record");
  const context = validateCommon(record, registry, now);
  if (record.recordType === "prepared") validatePrepared(record, registry, context);
  if (record.recordType === "manual") validateManual(record, registry, context);
  if (record.recordType === "final") validateFinal(record, registry, context);
  return {
    recordType: record.recordType,
    attemptId: record.attemptId,
    registryVersion: record.registryVersion,
    scenarioCount: record.scenarioResults.length,
    decision: record.recordType === "final" ? record.decision.value : undefined
  };
}

function comparableIdentity(record) {
  return {
    attemptId: record.attemptId,
    registryVersion: record.registryVersion,
    environment: record.environment,
    candidateSha: record.candidateSha,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    deployments: record.deployments,
    providerIdentityHashes: record.providerIdentityHashes
  };
}

function proofMap(record, modes) {
  return new Map(record.scenarioResults.flatMap((scenario) =>
    scenario.proofs
      .filter(({ mode }) => modes.includes(mode))
      .map((proof) => [`${scenario.id}:${proof.mode}`, proof])
  ));
}

export function validateStagingGateBundle({ prepared, manual, final }, registry, { now = new Date() } = {}) {
  assert.equal(prepared?.recordType, "prepared", "bundle prepared record is required");
  assert.equal(manual?.recordType, "manual", "bundle manual record is required");
  assert.equal(final?.recordType, "final", "bundle final record is required");
  validateStagingGateRecord(prepared, registry, { now });
  validateStagingGateRecord(manual, registry, { now });
  validateStagingGateRecord(final, registry, { now });
  assert.deepEqual(comparableIdentity(manual), comparableIdentity(prepared), "manual record identity differs from prepared record");
  assert.deepEqual(comparableIdentity(final), comparableIdentity(prepared), "final record identity differs from prepared record");
  assert.deepEqual(final.preparedRecordRef, manual.preparedRecordRef, "final preparedRecordRef differs from the manual record");
  const preparedDigest = digestCanonicalJson(prepared);
  const manualDigest = digestCanonicalJson(manual);
  assert.equal(manual.preparedRecordRef.sha256, preparedDigest, "manual preparedRecordRef digest differs from the prepared record");
  assert.equal(final.preparedRecordRef.sha256, preparedDigest, "final preparedRecordRef digest differs from the prepared record");
  assert.equal(final.manualRecordRef.sha256, manualDigest, "final manualRecordRef digest differs from the manual record");

  const providerBindings = new Map(prepared.providerObjectBindings.map((binding) => [
    `${binding.scenarioId}:${binding.provider}`,
    binding.objectHash
  ]));
  for (const reference of manual.providerReferences) {
    const key = `${reference.scenarioId}:${reference.provider}`;
    assert.ok(providerBindings.has(key), `provider reference ${reference.id} has no prepared object binding`);
    assert.equal(reference.objectHash, providerBindings.get(key), `provider reference ${reference.id} object differs from the prepared binding`);
  }

  const sourceProofs = new Map([
    ...proofMap(prepared, ["candidate", "staging"]),
    ...proofMap(manual, ["provider"])
  ]);
  const finalProofs = proofMap(final, ["candidate", "staging", "provider"]);
  assert.equal(finalProofs.size, sourceProofs.size, "final proof count differs from source records");
  for (const [key, sourceProof] of sourceProofs) {
    assert.ok(finalProofs.has(key), `final record is missing source proof ${key}`);
    assert.deepEqual(finalProofs.get(key), sourceProof, `final proof ${key} differs from its immutable source`);
  }
  return {
    attemptId: final.attemptId,
    registryVersion: final.registryVersion,
    scenarioCount: final.scenarioResults.length,
    decision: final.decision.value
  };
}

function parseArgs(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0 || !argv[index + 1]) throw new Error(`Use ${flag} <path>`);
    return argv[index + 1];
  };
  const recordIndex = argv.indexOf("--record");
  const hasBundle = ["--prepared-record", "--manual-record", "--final-record"].some((flag) => argv.includes(flag));
  assert.ok((recordIndex >= 0) !== hasBundle, "Use either --record or all three bundle record flags");
  return {
    registryPath: valueAfter("--registry"),
    recordPath: recordIndex >= 0 ? valueAfter("--record") : undefined,
    preparedPath: hasBundle ? valueAfter("--prepared-record") : undefined,
    manualPath: hasBundle ? valueAfter("--manual-record") : undefined,
    finalPath: hasBundle ? valueAfter("--final-record") : undefined,
    now: argv.includes("--now") ? new Date(valueAfter("--now")) : new Date()
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert.ok(Number.isFinite(args.now.getTime()), "--now must be an ISO timestamp");
  const registry = await readFile(args.registryPath, "utf8").then(JSON.parse);
  if (args.recordPath) {
    const record = await readFile(args.recordPath, "utf8").then(JSON.parse);
    const result = validateStagingGateRecord(record, registry, { now: args.now });
    console.log(JSON.stringify({ event: "staging.gate.record.validated", ...result }));
    return;
  }
  const [prepared, manual, final] = await Promise.all([
    readFile(args.preparedPath, "utf8").then(JSON.parse),
    readFile(args.manualPath, "utf8").then(JSON.parse),
    readFile(args.finalPath, "utf8").then(JSON.parse)
  ]);
  const result = validateStagingGateBundle({ prepared, manual, final }, registry, { now: args.now });
  console.log(JSON.stringify({ event: "staging.gate.bundle.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.gate.record.invalid", errorCode: "STAGING_GATE_RECORD_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
