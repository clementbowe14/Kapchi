#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateCandidateReport } from "./staging-gate-evidence.mjs";
import { validateResourceControlReport } from "./staging-gate-control.mjs";
import {
  deriveLogScanReport,
  deriveProviderReport,
  deriveScenarioReport
} from "./staging-gate-derived-evidence.mjs";
import { digestBundledArtifact } from "./verify-staging-artifact.mjs";

const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const PROOF_STATUSES = new Set(["pass", "fail", "pending"]);
const PROVIDER_NAMES = ["stripe", "vercel", "clerk", "messaging", "logs"];
const ARTIFACT_NAMES = ["candidate", "staging", "provider", "logScan", "cleanup"];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
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

function validateWorkflow(workflow, label) {
  exactKeys(workflow, ["repository", "workflowFile", "workflowSha", "runId", "runAttempt", "actor"], label);
  assert.match(workflow.repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `${label}.repository is invalid`);
  assert.match(workflow.workflowFile ?? "", /^\.github\/workflows\/staging-release-[A-Za-z0-9_.-]+\.yml$/, `${label}.workflowFile is invalid`);
  fullSha(workflow.workflowSha, `${label}.workflowSha`);
  assert.ok(Number.isSafeInteger(workflow.runId) && workflow.runId > 0, `${label}.runId must be positive`);
  assert.ok(Number.isSafeInteger(workflow.runAttempt) && workflow.runAttempt > 0, `${label}.runAttempt must be positive`);
  nonEmptyString(workflow.actor, `${label}.actor`);
}

export function validateScenarioRegistry(registry) {
  exactKeys(registry, ["registryVersion", "issue", "updatedAt", "proofModes", "approvedEvidenceHosts", "candidateSuites", "scenarios"], "scenario registry");
  assert.ok(Number.isSafeInteger(registry.registryVersion) && registry.registryVersion >= 2, "registryVersion must be at least 2");
  assert.equal(registry.issue, 115, "registry issue must be 115");
  timestamp(registry.updatedAt, "registry.updatedAt");
  assert.deepEqual(registry.proofModes, ["candidate", "staging", "provider"], "registry proofModes are invalid");
  exactKeys(registry.approvedEvidenceHosts, PROVIDER_NAMES, "approvedEvidenceHosts");
  for (const [provider, hosts] of Object.entries(registry.approvedEvidenceHosts)) {
    stringArray(hosts, `approvedEvidenceHosts.${provider}`);
    hosts.forEach((host) => {
      assert.equal(new URL(`https://${host}`).hostname, host, `approvedEvidenceHosts.${provider} contains an invalid host`);
      assert.ok(!host.startsWith("*."), `approvedEvidenceHosts.${provider} must use exact hosts`);
    });
  }

  assert.ok(Array.isArray(registry.candidateSuites) && registry.candidateSuites.length > 0, "candidateSuites must not be empty");
  const suiteIds = new Set();
  for (const suite of registry.candidateSuites) {
    exactKeys(suite, ["id", "workingDirectory", "command", "resultFormat"], `candidateSuites.${suite.id ?? "unknown"}`);
    assert.match(suite.id ?? "", /^[a-z][a-z0-9-]{2,63}$/, "candidate suite ID is invalid");
    assert.ok(!suiteIds.has(suite.id), `duplicate candidate suite ${suite.id}`);
    suiteIds.add(suite.id);
    stringArray(suite.command, `candidateSuites.${suite.id}.command`);
    assert.ok(["exit-code", "vitest-json", "node-test-json", "node-test-tap"].includes(suite.resultFormat), `${suite.id} has an invalid result format`);
    assert.ok(!suite.workingDirectory.startsWith("/") && !suite.workingDirectory.split(/[\\/]/).includes(".."), `${suite.id} working directory escapes the repository`);
  }

  assert.ok(Array.isArray(registry.scenarios) && registry.scenarios.length === 25, "registry must contain exactly 25 scenarios");
  const ids = new Set();
  registry.scenarios.forEach((scenario, index) => {
    const label = `scenarios[${index}]`;
    const expectedKeys = ["id", "title", "proofModes", "canonicalOwners", "fixtures", "assertions"];
    if (scenario.proofModes.includes("provider")) expectedKeys.push("providerObservations");
    exactKeys(scenario, expectedKeys, label);
    assert.match(scenario.id ?? "", /^[A-Z][A-Z0-9-]{2,63}$/, `${label}.id is invalid`);
    assert.ok(!ids.has(scenario.id), `duplicate scenario ID ${scenario.id}`);
    ids.add(scenario.id);
    nonEmptyString(scenario.title, `${label}.title`);
    stringArray(scenario.proofModes, `${label}.proofModes`);
    scenario.proofModes.forEach((mode) => assert.ok(registry.proofModes.includes(mode), `${scenario.id} uses unknown proof mode ${mode}`));
    assert.ok(Array.isArray(scenario.canonicalOwners) && scenario.canonicalOwners.length > 0, `${label}.canonicalOwners must not be empty`);
    scenario.canonicalOwners.forEach((owner, ownerIndex) => {
      exactKeys(owner, ["file", "testIds"], `${scenario.id}.canonicalOwners[${ownerIndex}]`);
      assert.match(owner.file, /^(?:backend\/src|client|scripts)\/[A-Za-z0-9_./-]+\.(?:test|spec)\.(?:ts|tsx|mjs)$/, `${scenario.id} owner must be an exact test file`);
      stringArray(owner.testIds, `${scenario.id}.canonicalOwners[${ownerIndex}].testIds`);
    });
    assert.ok(scenario.canonicalOwners.some((owner) => !owner.file.includes(".staging.spec.")), `${scenario.id} requires a candidate test owner`);
    if (scenario.proofModes.includes("staging")) assert.ok(scenario.canonicalOwners.some((owner) => owner.file.includes(".staging.spec.")), `${scenario.id} requires a staging report owner`);
    if (scenario.proofModes.includes("provider")) {
      assert.ok(Array.isArray(scenario.providerObservations) && scenario.providerObservations.length > 0, `${scenario.id}.providerObservations are required`);
      for (const [proofIndex, proof] of scenario.providerObservations.entries()) {
        exactKeys(proof, ["id", "provider"], `${scenario.id}.providerObservations[${proofIndex}]`);
        assert.match(proof.id ?? "", /^[A-Z0-9-]+:[a-z0-9-]+$/, `${scenario.id} provider observation ID is invalid`);
        assert.ok(["stripe", "vercel", "clerk", "blob", "redis", "messaging", "logs"].includes(proof.provider), `${scenario.id} provider is invalid`);
      }
    }
    stringArray(scenario.fixtures, `${label}.fixtures`);
    stringArray(scenario.assertions, `${label}.assertions`);
  });
  return { registryVersion: registry.registryVersion, scenarioCount: registry.scenarios.length };
}

function validateDeployment(deployment, label, candidateSha) {
  exactKeys(deployment, ["projectId", "deploymentId", "sourceSha", "immutableUrl"], label);
  nonEmptyString(deployment.projectId, `${label}.projectId`);
  assert.match(deployment.deploymentId ?? "", DEPLOYMENT_ID, `${label}.deploymentId is invalid`);
  assert.equal(deployment.sourceSha, candidateSha, `${label}.sourceSha differs from candidate`);
  const url = new URL(deployment.immutableUrl);
  assert.equal(url.protocol, "https:", `${label}.immutableUrl must use HTTPS`);
  assert.ok(url.hostname.endsWith(".vercel.app"), `${label}.immutableUrl must be a Vercel deployment URL`);
  assert.ok(url.pathname !== "/", `${label}.immutableUrl must identify a release endpoint`);
  assert.equal(url.search, "", `${label}.immutableUrl must not contain a query`);
  assert.equal(url.hash, "", `${label}.immutableUrl must not contain a fragment`);
}

function validateArtifactBinding(binding, label, expected) {
  exactKeys(binding, ["artifactId", "name", "archiveSha256", "contentSha256", "reportDigest", "repository", "workflowFile", "workflowSha", "runId", "runAttempt", "candidateSha", "createdAt", "downloadUrl"], label);
  assert.ok(Number.isSafeInteger(binding.artifactId) && binding.artifactId > 0, `${label}.artifactId must be positive`);
  assert.match(binding.name ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/, `${label}.name is invalid`);
  sha256(binding.archiveSha256, `${label}.archiveSha256`);
  sha256(binding.contentSha256, `${label}.contentSha256`);
  sha256(binding.reportDigest, `${label}.reportDigest`);
  assert.equal(binding.reportDigest, expected.digest, `${label}.reportDigest differs from its report`);
  assert.equal(binding.repository, expected.workflow.repository, `${label}.repository differs from its workflow`);
  assert.equal(binding.workflowFile, expected.workflow.workflowFile, `${label}.workflowFile differs from its workflow`);
  assert.equal(binding.workflowSha, expected.workflow.workflowSha, `${label}.workflowSha differs from its workflow`);
  assert.equal(binding.runId, expected.workflow.runId, `${label}.runId differs from its workflow`);
  assert.equal(binding.runAttempt, expected.workflow.runAttempt, `${label}.runAttempt differs from its workflow`);
  assert.equal(binding.candidateSha, expected.candidateSha, `${label}.candidateSha differs from the record`);
  timestamp(binding.createdAt, `${label}.createdAt`);
  const url = new URL(binding.downloadUrl);
  assert.equal(url.protocol, "https:", `${label}.downloadUrl must use HTTPS`);
  assert.equal(url.hostname, "github.com", `${label}.downloadUrl must use github.com`);
  assert.equal(url.search, "", `${label}.downloadUrl must not contain a query`);
  assert.equal(url.hash, "", `${label}.downloadUrl must not contain a fragment`);
  assert.equal(url.pathname, `/${binding.repository}/actions/runs/${binding.runId}/artifacts/${binding.artifactId}`, `${label}.downloadUrl does not match the recorded run and artifact`);
  exactKeys(expected.verification, ["verificationVersion", "artifactId", "name", "runId", "runAttempt", "candidateSha", "archiveBytes", "archiveSha256", "contentSha256", "files"], `${label} verification`);
  assert.equal(expected.verification.verificationVersion, 1, `${label} verification version is invalid`);
  assert.equal(expected.verification.artifactId, binding.artifactId, `${label} verification artifact ID differs`);
  assert.equal(expected.verification.name, binding.name, `${label} verification name differs`);
  assert.equal(expected.verification.runId, binding.runId, `${label} verification run ID differs`);
  assert.equal(expected.verification.runAttempt, binding.runAttempt, `${label} verification run attempt differs`);
  assert.equal(expected.verification.candidateSha, binding.candidateSha, `${label} verification candidate differs`);
  assert.equal(expected.verification.archiveSha256, binding.archiveSha256, `${label} archive digest was not recomputed from the downloaded artifact`);
  assert.equal(expected.verification.contentSha256, binding.contentSha256, `${label} content digest was not recomputed from the extracted artifact`);
  assert.ok(Number.isSafeInteger(expected.verification.archiveBytes) && expected.verification.archiveBytes > 0, `${label} verification archive size is invalid`);
  stringArray(expected.verification.files, `${label} verification files`);
  exactKeys(expected.recomputed, ["archiveBytes", "archiveSha256", "contentSha256", "files"], `${label} recomputed artifact digests`);
  assert.deepEqual(
    expected.verification,
    { ...expected.verification, ...expected.recomputed },
    `${label} verification does not match the bundled archive and extracted contents`,
  );
}

function aggregateStatus(statuses) {
  return statuses.includes("fail") ? "fail" : statuses.includes("pending") ? "pending" : "pass";
}

export function deriveV2Decision(record, registry) {
  const reasons = [];
  for (const scenario of registry.scenarios) {
    const result = record.scenarioResults.find(({ id }) => id === scenario.id);
    for (const mode of scenario.proofModes) {
      if (result?.[mode] !== "pass") reasons.push(`SCENARIO_${scenario.id}_${mode.toUpperCase()}_${String(result?.[mode] ?? "MISSING").toUpperCase()}`);
    }
  }
  for (const [name, status] of Object.entries(record.evidenceStatus)) {
    if (status !== "pass") reasons.push(`EVIDENCE_${name.toUpperCase()}_${status.toUpperCase()}`);
  }
  if (record.blockers.length > 0) reasons.push("BLOCKERS_REMAIN");
  return { value: reasons.length === 0 ? "GO" : "NO-GO", reasonCodes: [...new Set(reasons)].sort() };
}

export function validateStagingGateV2Record(record, registry, sources, { now = new Date() } = {}) {
  validateScenarioRegistry(registry);
  exactKeys(record, ["recordVersion", "recordType", "trustMode", "issue", "attemptId", "environment", "candidate", "createdAt", "expiresAt", "workflow", "deploymentCredentials", "deployments", "aliases", "providerIdentityHashes", "reportDigests", "artifactBindings", "scenarioResults", "evidenceStatus", "resourceControl", "blockers", "decision"], "record");
  assert.equal(record.recordVersion, 2, "recordVersion must be 2");
  assert.equal(record.recordType, "final", "recordType must be final");
  assert.equal(record.trustMode, "single-owner-procedural", "trustMode must describe the current procedural control");
  assert.equal(record.issue, 115, "record issue must be 115");
  assert.match(record.attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.equal(record.environment, "staging", "environment must be staging");
  exactKeys(record.candidate, ["sha", "lockfileDigest", "registryVersion"], "candidate");
  fullSha(record.candidate.sha, "candidate.sha");
  sha256(record.candidate.lockfileDigest, "candidate.lockfileDigest");
  assert.equal(record.candidate.registryVersion, registry.registryVersion, "candidate.registryVersion differs from registry");
  const createdAt = timestamp(record.createdAt, "createdAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  assert.ok(createdAt <= now.getTime() + CLOCK_SKEW_MS, "record was created in the future");
  assert.ok(expiresAt > createdAt && expiresAt - createdAt <= MAX_FRESHNESS_MS, "record validity must be within 24 hours");
  assert.ok(now.getTime() <= expiresAt + CLOCK_SKEW_MS, "record is stale");
  validateWorkflow(record.workflow, "workflow");

  exactKeys(record.deploymentCredentials, ["stagingIdentityHash", "productionIdentityHash"], "deploymentCredentials");
  sha256(record.deploymentCredentials.stagingIdentityHash, "deploymentCredentials.stagingIdentityHash");
  sha256(record.deploymentCredentials.productionIdentityHash, "deploymentCredentials.productionIdentityHash");
  assert.notEqual(record.deploymentCredentials.stagingIdentityHash, record.deploymentCredentials.productionIdentityHash, "staging and production deployment identities must differ");
  exactKeys(record.deployments, ["staging", "productionPreflight"], "deployments");
  exactKeys(record.deployments.staging, ["storefront", "api"], "deployments.staging");
  validateDeployment(record.deployments.staging.storefront, "deployments.staging.storefront", record.candidate.sha);
  validateDeployment(record.deployments.staging.api, "deployments.staging.api", record.candidate.sha);
  assert.notEqual(record.deployments.staging.storefront.deploymentId, record.deployments.staging.api.deploymentId, "staging deployment IDs must differ");
  exactKeys(record.deployments.productionPreflight, ["productionBranch", "storefrontProjectId", "apiProjectId", "checkedAt"], "deployments.productionPreflight");
  assert.equal(record.deployments.productionPreflight.productionBranch, "production", "Vercel Production Branch must be production");
  assert.equal(record.deployments.productionPreflight.storefrontProjectId, record.deployments.staging.storefront.projectId, "storefront project preflight differs");
  assert.equal(record.deployments.productionPreflight.apiProjectId, record.deployments.staging.api.projectId, "API project preflight differs");
  timestamp(record.deployments.productionPreflight.checkedAt, "deployments.productionPreflight.checkedAt");

  exactKeys(record.aliases, ["siteDomain", "storefront", "api", "storefrontDeploymentId", "apiDeploymentId", "verifiedAt"], "aliases");
  assert.match(record.aliases.siteDomain ?? "", /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "siteDomain must be a lowercase multi-label DNS name");
  assert.ok(record.aliases.siteDomain.split(".").length >= 2, "siteDomain must contain at least two labels");
  const storefrontAlias = new URL(record.aliases.storefront);
  const apiAlias = new URL(record.aliases.api);
  for (const [label, alias] of [["storefront", storefrontAlias], ["API", apiAlias]]) {
    assert.equal(alias.protocol, "https:", `${label} alias must use HTTPS`);
    assert.equal(alias.origin, label === "storefront" ? record.aliases.storefront : record.aliases.api, `${label} alias must be an exact origin`);
    assert.equal(alias.username, "", `${label} alias must not contain credentials`);
    assert.equal(alias.password, "", `${label} alias must not contain credentials`);
    assert.equal(alias.port, "", `${label} alias must use the default HTTPS port`);
  }
  const storefrontLabels = storefrontAlias.hostname.split(".");
  const apiLabels = apiAlias.hostname.split(".");
  const siteLabels = record.aliases.siteDomain.split(".");
  assert.equal(storefrontLabels.length, siteLabels.length + 1, "storefront alias must be one direct sibling below siteDomain");
  assert.equal(apiLabels.length, siteLabels.length + 1, "API alias must be one direct sibling below siteDomain");
  assert.ok(storefrontAlias.hostname.endsWith(`.${record.aliases.siteDomain}`), "storefront alias is outside siteDomain");
  assert.ok(apiAlias.hostname.endsWith(`.${record.aliases.siteDomain}`), "API alias is outside siteDomain");
  assert.notEqual(storefrontAlias.hostname, apiAlias.hostname, "staging aliases must use distinct sibling hosts");
  assert.equal(record.aliases.storefrontDeploymentId, record.deployments.staging.storefront.deploymentId, "storefront alias targets the wrong deployment");
  assert.equal(record.aliases.apiDeploymentId, record.deployments.staging.api.deploymentId, "API alias targets the wrong deployment");
  timestamp(record.aliases.verifiedAt, "aliases.verifiedAt");

  exactKeys(record.providerIdentityHashes, ["database", "stripe", "clerk", "blob", "redis", "messaging", "vercel", "logs"], "providerIdentityHashes");
  Object.entries(record.providerIdentityHashes).forEach(([provider, value]) => sha256(value, `providerIdentityHashes.${provider}`));
  exactKeys(record.reportDigests, ARTIFACT_NAMES, "reportDigests");
  Object.entries(record.reportDigests).forEach(([report, value]) => sha256(value, `reportDigests.${report}`));
  exactKeys(record.artifactBindings, ARTIFACT_NAMES, "artifactBindings");

  assert.ok(sources?.candidateReport && Array.isArray(sources?.candidateReceipts), "candidate report and receipts are required");
  const candidateResult = validateCandidateReport(sources.candidateReport, registry, sources.candidateReceipts);
  assert.equal(sources.candidateReport.candidateSha, record.candidate.sha, "candidate report SHA differs");
  assert.equal(sources.candidateReport.lockfileDigest, record.candidate.lockfileDigest, "candidate report lockfile differs");
  const stagingReport = deriveScenarioReport({
    registry,
    observations: sources.stagingObservations,
    attemptId: record.attemptId,
    candidateSha: record.candidate.sha,
    createdAt: sources.stagingReport.createdAt
  });
  assert.deepEqual(sources.stagingReport, stagingReport, "staging report is not derived from raw scenario observations");
  const providerReport = deriveProviderReport({
    registry,
    observations: sources.providerObservations,
    providerIdentityHashes: record.providerIdentityHashes,
    attemptId: record.attemptId,
    candidateSha: record.candidate.sha,
    createdAt: sources.providerReport.createdAt
  });
  assert.deepEqual(sources.providerReport, providerReport, "provider report is not derived from bounded provider observations");
  const logScanReport = deriveLogScanReport({
    input: sources.sanitizedLogInput,
    attemptId: record.attemptId,
    candidateSha: record.candidate.sha,
    createdAt: sources.logScanReport.createdAt,
    logCanaries: sources.logCanaries
  });
  assert.deepEqual(sources.logScanReport, logScanReport, "log scan report is not derived from sanitized log input");
  const stagingStatuses = new Map(stagingReport.scenarioResults.map((result) => [result.id, result.status]));
  const providerStatuses = new Map(providerReport.scenarioResults.map((result) => [result.id, result.status]));
  const logScanStatus = logScanReport.status;
  const resourceResult = validateResourceControlReport(sources.resourceReport, sources.resourceExport);
  const sourceDigests = {
    candidate: candidateResult.reportDigest,
    staging: stagingReport.reportDigest,
    provider: providerReport.reportDigest,
    logScan: logScanReport.reportDigest,
    cleanup: resourceResult.reportDigest
  };
  assert.deepEqual(record.reportDigests, sourceDigests, "reportDigests differ from supplied evidence");

  const candidateWorkflow = sources.candidateReport.workflow;
  validateWorkflow(candidateWorkflow, "candidate report workflow");
  for (const name of ARTIFACT_NAMES) {
    const workflow = name === "candidate" ? candidateWorkflow : record.workflow;
    assert.ok(sources.artifactVerifications?.[name], `downloaded artifact verification is required for ${name}`);
    assert.ok(sources.artifactDigests?.[name], `bundled artifact archive and contents are required for ${name}`);
    validateArtifactBinding(record.artifactBindings[name], `artifactBindings.${name}`, {
      digest: sourceDigests[name],
      workflow,
      candidateSha: record.candidate.sha,
      verification: sources.artifactVerifications[name],
      recomputed: sources.artifactDigests[name]
    });
  }

  const candidateStatuses = new Map(sources.candidateReport.scenarioResults.map((result) => [result.id, result.status]));
  const expectedScenarioResults = registry.scenarios.map((scenario) => ({
    id: scenario.id,
    candidate: scenario.proofModes.includes("candidate") ? candidateStatuses.get(scenario.id) ?? "pending" : null,
    staging: scenario.proofModes.includes("staging") ? stagingStatuses.get(scenario.id) ?? "pending" : null,
    provider: scenario.proofModes.includes("provider") ? providerStatuses.get(scenario.id) ?? "pending" : null
  }));
  assert.deepEqual(record.scenarioResults, expectedScenarioResults, "scenarioResults are not derived from source reports");

  exactKeys(record.resourceControl, ["reportDigest", "status", "resourceCount", "expectedResourceCount", "expectedResourceDigest"], "resourceControl");
  assert.deepEqual(record.resourceControl, resourceResult, "resourceControl differs from validated cleanup evidence");
  const expectedEvidenceStatus = {
    candidate: sources.candidateReport.decision,
    staging: aggregateStatus([...stagingStatuses.values()]),
    provider: aggregateStatus([...providerStatuses.values()]),
    logScan: logScanStatus,
    cleanup: resourceResult.status
  };
  assert.deepEqual(record.evidenceStatus, expectedEvidenceStatus, "evidenceStatus is not derived from source reports");
  assert.ok(Array.isArray(record.blockers) && record.blockers.every((blocker) => typeof blocker === "string" && blocker.trim()), "blockers must be non-empty strings");
  exactKeys(record.decision, ["value", "reasonCodes", "derivedBy", "finalizedAt"], "decision");
  assert.equal(record.decision.derivedBy, "scripts/validate-staging-gate.mjs", "decision must be validator-derived");
  timestamp(record.decision.finalizedAt, "decision.finalizedAt");
  const expectedDecision = deriveV2Decision(record, registry);
  assert.equal(record.decision.value, expectedDecision.value, `decision must be ${expectedDecision.value}`);
  assert.deepEqual(record.decision.reasonCodes, expectedDecision.reasonCodes, "decision reason codes differ");
  return { recordType: "final", attemptId: record.attemptId, registryVersion: registry.registryVersion, scenarioCount: record.scenarioResults.length, decision: record.decision.value };
}

export function validateStagingGateRecord(record, registry, options = {}) {
  assert.equal(record?.recordVersion, 2, "only procedural staging gate recordVersion 2 is supported");
  return validateStagingGateV2Record(record, registry, options.sources, options);
}

function parseArgs(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0 || !argv[index + 1]) throw new Error(`Use ${flag} <path>`);
    return argv[index + 1];
  };
  return {
    bundlePath: valueAfter("--bundle"),
    registryPath: valueAfter("--registry"),
    now: argv.includes("--now") ? new Date(valueAfter("--now")) : new Date()
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function loadStagingGateBundle(bundlePath) {
  const root = path.resolve(bundlePath);
  const receiptsDirectory = path.join(root, "candidate", "receipts");
  const receiptFiles = (await readdir(receiptsDirectory)).filter((file) => file.endsWith(".json")).sort();
  const [record, candidateReport, candidateReceipts, stagingReport, stagingObservations, providerReport, providerObservations, sanitizedLogInput, logCanaries, logScanReport, resourceReport, resourceExport, artifactVerifications, artifactDigestEntries] = await Promise.all([
    readJson(path.join(root, "record.json")),
    readJson(path.join(root, "candidate", "report.json")),
    Promise.all(receiptFiles.map((file) => readJson(path.join(receiptsDirectory, file)))),
    readJson(path.join(root, "staging", "report.json")),
    readJson(path.join(root, "staging", "observations.json")),
    readJson(path.join(root, "provider", "report.json")),
    readJson(path.join(root, "provider", "observations.json")),
    readFile(path.join(root, "logs", "sanitized.ndjson"), "utf8"),
    readJson(path.join(root, "logs", "canaries.json")),
    readJson(path.join(root, "logs", "report.json")),
    readJson(path.join(root, "cleanup", "report.json")),
    readJson(path.join(root, "cleanup", "export.json")),
    readJson(path.join(root, "artifacts", "verifications.json")),
    Promise.all(ARTIFACT_NAMES.map(async (name) => [name, await digestBundledArtifact({
      archivePath: path.join(root, "artifacts", name, "archive.zip"),
      contentsDirectory: path.join(root, "artifacts", name, "contents")
    })]))
  ]);
  const artifactDigests = Object.fromEntries(artifactDigestEntries);
  return {
    record,
    sources: { candidateReport, candidateReceipts, stagingReport, stagingObservations, providerReport, providerObservations, sanitizedLogInput, logCanaries, logScanReport, resourceReport, resourceExport, artifactVerifications, artifactDigests }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert.ok(Number.isFinite(args.now.getTime()), "--now must be an ISO timestamp");
  const [registry, bundle] = await Promise.all([readJson(args.registryPath), loadStagingGateBundle(args.bundlePath)]);
  const result = validateStagingGateRecord(bundle.record, registry, { now: args.now, sources: bundle.sources });
  console.log(JSON.stringify({ event: "staging.gate.bundle.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.gate.record.invalid", errorCode: "STAGING_GATE_RECORD_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
