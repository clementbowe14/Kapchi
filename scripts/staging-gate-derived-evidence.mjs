#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const PROVIDERS = new Set(["stripe", "vercel", "clerk", "blob", "redis", "messaging", "logs"]);
const OUTCOMES = new Set(["passed", "failed", "skipped"]);
const LOG_CANARY_KINDS = ["address", "customization", "filename", "provider"];
const LOG_CANARY = /^KAPCHI_LOG_CANARY_(?:ADDRESS|CUSTOMIZATION|FILENAME|PROVIDER)_[0-9A-F]{24}$/;
const FORBIDDEN_LOG_PATTERNS = [
  ["authorization", /(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s,"'}]+/i],
  ["cookie", /(?:cookie|set-cookie)["']?\s*[:=]\s*["'][^"']+/i],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["stripe-secret", /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}\b/],
  ["payment-card", /\b(?:\d[ -]*?){13,19}\b/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];
const FORBIDDEN_LOG_KEYS = new Map([
  ["address", "address"],
  ["shippingaddress", "address"],
  ["billingaddress", "address"],
  ["streetaddress", "address"],
  ["addressline1", "address"],
  ["addressline2", "address"],
  ["postalcode", "address"],
  ["zipcode", "address"],
  ["customizationtext", "customization-text"],
  ["customtext", "customization-text"],
  ["personalizationtext", "customization-text"],
  ["embroiderytext", "customization-text"],
  ["filename", "filename"],
  ["originalfilename", "filename"],
  ["providerpayload", "provider-payload"],
  ["rawpayload", "provider-payload"],
  ["stripepayload", "provider-payload"],
  ["webhookpayload", "provider-payload"],
  ["payload", "provider-payload"]
]);
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,}\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/i;
const SENSITIVE_FILENAME = /(?:^|[/\\])[^/\\\s]+\.(?:avif|bmp|gif|heic|jpe?g|pdf|png|svg|tiff?|webp|docx?)$/i;

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stringFindings(value, canaryValues) {
  const findings = [];
  if (STREET_ADDRESS.test(value)) findings.push("address-value");
  if (SENSITIVE_FILENAME.test(value)) findings.push("filename-value");
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const candidate of urls) {
    let url;
    try { url = new URL(candidate); } catch { continue; }
    if (url.search) findings.push("url-query-string");
    if (url.hostname === "blob.vercel-storage.com" || url.hostname.endsWith(".blob.vercel-storage.com")) {
      findings.push("private-blob-url");
    }
  }
  if (canaryValues.some((canary) => value.includes(canary))) findings.push("log-canary");
  return [...new Set(findings)];
}

function inspectStructuredLog(value, canaryValues, findings, line, path = "$") {
  if (typeof value === "string") {
    for (const code of stringFindings(value, canaryValues)) findings.push({ line, code, path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectStructuredLog(entry, canaryValues, findings, line, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const forbiddenCode = FORBIDDEN_LOG_KEYS.get(normalizedKey(key));
    if (forbiddenCode) findings.push({ line, code: `forbidden-key:${forbiddenCode}`, path: childPath });
    inspectStructuredLog(entry, canaryValues, findings, line, childPath);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildLogCanaryBundle({ attemptId, candidateSha }) {
  assert.match(attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.match(candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  return {
    canaryVersion: 1,
    attemptId,
    candidateSha,
    values: LOG_CANARY_KINDS.map((kind) => ({
      kind,
      value: `KAPCHI_LOG_CANARY_${kind.toUpperCase()}_${createHash("sha256").update(`${attemptId}:${candidateSha}:${kind}`).digest("hex").slice(0, 24).toUpperCase()}`
    }))
  };
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys do not match the contract`);
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, `${label} must be a canonical ISO timestamp`);
  return parsed;
}

function scenarioMap(registry, mode) {
  return new Map(registry.scenarios.filter((scenario) => scenario.proofModes.includes(mode)).map((scenario) => [scenario.id, scenario]));
}

function aggregate(values) {
  return values.includes("fail") ? "fail" : values.includes("pending") ? "pending" : "pass";
}

export function deriveScenarioReport({ registry, observations, attemptId, candidateSha, createdAt }) {
  assert.match(attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.match(candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  timestamp(createdAt, "createdAt");
  assert.ok(Array.isArray(observations), "scenario observations must be an array");
  const scenarios = scenarioMap(registry, "staging");
  const byScenario = new Map();
  for (const [index, observation] of observations.entries()) {
    const label = `scenario observations[${index}]`;
    exactKeys(observation, ["observationVersion", "scenarioId", "testId", "attemptId", "candidateSha", "startedAt", "finishedAt", "outcome", "assertionIds"], label);
    assert.equal(observation.observationVersion, 1, `${label}.observationVersion is invalid`);
    const scenario = scenarios.get(observation.scenarioId);
    assert.ok(scenario, `${label}.scenarioId is not a reviewed staging scenario`);
    assert.equal(observation.attemptId, attemptId, `${label}.attemptId differs`);
    assert.equal(observation.candidateSha, candidateSha, `${label}.candidateSha differs`);
    const started = timestamp(observation.startedAt, `${label}.startedAt`);
    const finished = timestamp(observation.finishedAt, `${label}.finishedAt`);
    assert.ok(finished >= started && finished - started <= 30 * 60 * 1000, `${label} must use a bounded observation window`);
    assert.ok(OUTCOMES.has(observation.outcome), `${label}.outcome is invalid`);
    assert.ok(Array.isArray(observation.assertionIds) && observation.assertionIds.length > 0, `${label}.assertionIds are required`);
    assert.deepEqual([...new Set(observation.assertionIds)].sort(), [...observation.assertionIds].sort(), `${label}.assertionIds contain duplicates`);
    const reviewedIds = new Set(scenario.canonicalOwners.filter(({ file }) => file.includes(".staging.spec.")).flatMap(({ testIds }) => testIds));
    assert.ok(reviewedIds.has(observation.testId), `${label}.testId is not a reviewed owner ID`);
    const requiredAssertions = scenario.assertions.map((_, assertionIndex) => `${scenario.id}:assertion:${assertionIndex + 1}`);
    assert.deepEqual([...observation.assertionIds].sort(), requiredAssertions.sort(), `${label}.assertionIds do not cover the reviewed assertions`);
    const scenarioObservations = byScenario.get(observation.scenarioId) ?? new Map();
    assert.ok(!scenarioObservations.has(observation.testId), `${label}.testId is duplicated for ${observation.scenarioId}`);
    scenarioObservations.set(observation.testId, observation);
    byScenario.set(observation.scenarioId, scenarioObservations);
  }
  const scenarioResults = [...scenarios.keys()].sort().map((id) => {
    const scenario = scenarios.get(id);
    const observationsByTest = byScenario.get(id) ?? new Map();
    const requiredTestIds = scenario.canonicalOwners
      .filter(({ file }) => file.includes(".staging.spec."))
      .flatMap(({ testIds }) => testIds);
    const observations = requiredTestIds.map((testId) => observationsByTest.get(testId)).filter(Boolean);
    const assertionCoverage = new Set(
      observations.filter(({ outcome }) => outcome === "passed").flatMap(({ assertionIds }) => assertionIds),
    );
    const requiredAssertions = scenario.assertions.map((_, index) => `${id}:assertion:${index + 1}`);
    const status = observations.some(({ outcome }) => outcome === "failed")
      ? "fail"
      : observations.length !== requiredTestIds.length
        || observations.some(({ outcome }) => outcome === "skipped")
        || requiredAssertions.some((assertionId) => !assertionCoverage.has(assertionId))
        ? "pending"
        : "pass";
    return {
      id,
      status,
      observationDigest: observations.length > 0
        ? evidenceDigest(observations.sort((left, right) => left.testId.localeCompare(right.testId)))
        : null,
    };
  });
  const body = {
    reportVersion: 2,
    reportType: "staging-scenario-derived-evidence",
    generatedBy: "scripts/staging-gate-derived-evidence.mjs",
    attemptId,
    candidateSha,
    registryVersion: registry.registryVersion,
    createdAt,
    observationCount: observations.length,
    scenarioResults,
    status: aggregate(scenarioResults.map(({ status }) => status))
  };
  return { ...body, reportDigest: evidenceDigest(body) };
}

export function deriveProviderReport({ registry, observations, providerIdentityHashes, attemptId, candidateSha, createdAt }) {
  assert.match(attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.match(candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  timestamp(createdAt, "createdAt");
  assert.ok(Array.isArray(observations), "provider observations must be an array");
  const scenarios = scenarioMap(registry, "provider");
  const byProof = new Map();
  for (const [index, observation] of observations.entries()) {
    const label = `provider observations[${index}]`;
    exactKeys(observation, ["observationVersion", "scenarioId", "reportId", "attemptId", "candidateSha", "provider", "windowStartedAt", "observedAt", "windowEndedAt", "expectedIdentityHash", "actualIdentityHash", "expectedResourceHash", "actualResourceHash", "outcomeCode"], label);
    assert.equal(observation.observationVersion, 1, `${label}.observationVersion is invalid`);
    const scenario = scenarios.get(observation.scenarioId);
    assert.ok(scenario, `${label}.scenarioId is not a reviewed provider scenario`);
    const proof = scenario.providerObservations?.find(({ id }) => id === observation.reportId);
    assert.ok(proof, `${label}.reportId is not reviewed`);
    assert.equal(observation.provider, proof.provider, `${label}.provider differs from the registry`);
    assert.ok(PROVIDERS.has(observation.provider), `${label}.provider is invalid`);
    assert.equal(observation.attemptId, attemptId, `${label}.attemptId differs`);
    assert.equal(observation.candidateSha, candidateSha, `${label}.candidateSha differs`);
    const start = timestamp(observation.windowStartedAt, `${label}.windowStartedAt`);
    const observed = timestamp(observation.observedAt, `${label}.observedAt`);
    const end = timestamp(observation.windowEndedAt, `${label}.windowEndedAt`);
    assert.ok(start <= observed && observed <= end && end - start <= 15 * 60 * 1000, `${label} must use a bounded provider window`);
    for (const key of ["expectedIdentityHash", "actualIdentityHash", "expectedResourceHash", "actualResourceHash"]) {
      assert.match(observation[key] ?? "", SHA256, `${label}.${key} is invalid`);
    }
    assert.equal(observation.expectedIdentityHash, providerIdentityHashes[observation.provider], `${label}.expectedIdentityHash differs from the gate identity`);
    assert.ok(["observed", "not-found", "mismatch", "provider-error"].includes(observation.outcomeCode), `${label}.outcomeCode is invalid`);
    assert.ok(!byProof.has(observation.reportId), `${label}.reportId is duplicated`);
    byProof.set(observation.reportId, observation);
  }
  const scenarioResults = [...scenarios.values()].sort((a, b) => a.id.localeCompare(b.id)).map((scenario) => {
    const required = scenario.providerObservations ?? [];
    assert.ok(required.length > 0, `${scenario.id} must declare providerObservations`);
    const found = required.map(({ id }) => byProof.get(id));
    const status = found.some((observation) => observation && (observation.outcomeCode !== "observed" || observation.expectedIdentityHash !== observation.actualIdentityHash || observation.expectedResourceHash !== observation.actualResourceHash))
      ? "fail"
      : found.some((observation) => !observation) ? "pending" : "pass";
    return { id: scenario.id, status, observationDigests: found.filter(Boolean).map(evidenceDigest).sort() };
  });
  const body = {
    reportVersion: 2,
    reportType: "provider-observation-derived-evidence",
    generatedBy: "scripts/staging-gate-derived-evidence.mjs",
    attemptId,
    candidateSha,
    registryVersion: registry.registryVersion,
    createdAt,
    observationCount: observations.length,
    scenarioResults,
    status: aggregate(scenarioResults.map(({ status }) => status))
  };
  return { ...body, reportDigest: evidenceDigest(body) };
}

export function deriveLogScanReport({ input, attemptId, candidateSha, createdAt, logCanaries }) {
  assert.match(attemptId ?? "", ATTEMPT_ID, "attemptId is invalid");
  assert.match(candidateSha ?? "", GIT_SHA, "candidateSha is invalid");
  timestamp(createdAt, "createdAt");
  assert.equal(typeof input, "string", "sanitized log input must be text");
  const expectedCanaries = buildLogCanaryBundle({ attemptId, candidateSha });
  assert.deepEqual(logCanaries, expectedCanaries, "log canaries must be the deterministic non-sensitive bundle for this attempt and candidate");
  const canaryValues = logCanaries.values.map(({ value }, index) => {
    assert.match(value, LOG_CANARY, `logCanaries.values[${index}].value is not a safe canary`);
    return value;
  });
  assert.ok(Buffer.byteLength(input) <= 5 * 1024 * 1024, "sanitized log input exceeds 5 MiB");
  const lines = input.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0 && lines.length <= 50_000, "sanitized log input must contain 1..50000 lines");
  let attemptMatches = 0;
  let candidateMatches = 0;
  const findings = [];
  lines.forEach((line, index) => {
    assert.ok(Buffer.byteLength(line) <= 16 * 1024, `log line ${index + 1} exceeds 16 KiB`);
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new Error(`log line ${index + 1} is not JSON`); }
    if (parsed.attemptId === attemptId) attemptMatches += 1;
    if (parsed.candidateSha === candidateSha) candidateMatches += 1;
    inspectStructuredLog(parsed, canaryValues, findings, index + 1);
    for (const [code, pattern] of FORBIDDEN_LOG_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: index + 1, code });
    }
  });
  if (attemptMatches === 0) findings.push({ line: 0, code: "missing-attempt-correlation" });
  if (candidateMatches === 0) findings.push({ line: 0, code: "missing-candidate-correlation" });
  const body = {
    reportVersion: 2,
    reportType: "sanitized-log-derived-evidence",
    generatedBy: "scripts/staging-gate-derived-evidence.mjs",
    attemptId,
    candidateSha,
    createdAt,
    inputDigest: createHash("sha256").update(input).digest("hex"),
    canaryDigest: evidenceDigest(logCanaries),
    canaryCount: canaryValues.length,
    lineCount: lines.length,
    findings,
    status: findings.length === 0 ? "pass" : "fail"
  };
  return { ...body, reportDigest: evidenceDigest(body) };
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`Use ${name} <value>`);
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const registry = command === "log-scan" ? undefined : JSON.parse(await readFile(arg(argv, "--registry"), "utf8"));
  const common = { attemptId: arg(argv, "--attempt-id"), candidateSha: arg(argv, "--candidate-sha"), createdAt: new Date().toISOString() };
  let report;
  if (command === "scenario-report") report = deriveScenarioReport({ registry, observations: JSON.parse(await readFile(arg(argv, "--observations"), "utf8")), ...common });
  else if (command === "provider-report") report = deriveProviderReport({ registry, observations: JSON.parse(await readFile(arg(argv, "--observations"), "utf8")), providerIdentityHashes: JSON.parse(await readFile(arg(argv, "--provider-identities"), "utf8")), ...common });
  else if (command === "log-scan") {
    const logCanaries = JSON.parse(await readFile(arg(argv, "--canaries"), "utf8"));
    report = deriveLogScanReport({ input: await readFile(arg(argv, "--input"), "utf8"), logCanaries, ...common });
  }
  else throw new Error("Use scenario-report, provider-report, or log-scan");
  await writeFile(arg(argv, "--output"), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.gate.derived-evidence.failed", reason: error.message }));
    process.exitCode = 1;
  });
}
