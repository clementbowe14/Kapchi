#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SUITE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const STATUS = new Set(["pass", "fail", "pending"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  const input = Buffer.isBuffer(value) || typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(input).digest("hex");
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys do not match the contract`);
}

function suiteMap(registry) {
  assert.ok(Array.isArray(registry.candidateSuites) && registry.candidateSuites.length > 0, "candidateSuites are required");
  const suites = new Map();
  for (const suite of registry.candidateSuites) {
    exactKeys(suite, ["id", "workingDirectory", "command", "resultFormat"], `candidate suite ${suite.id ?? "unknown"}`);
    assert.match(suite.id ?? "", SUITE_ID, "candidate suite ID is invalid");
    assert.ok(!suites.has(suite.id), `duplicate candidate suite ${suite.id}`);
    assert.ok(Array.isArray(suite.command) && suite.command.length > 0 && suite.command.every((part) => typeof part === "string" && part.length > 0), `${suite.id}.command is invalid`);
    assert.ok(["exit-code", "vitest-json", "node-test-json", "node-test-tap"].includes(suite.resultFormat), `${suite.id}.resultFormat is invalid`);
    assert.ok(!path.isAbsolute(suite.workingDirectory) && !suite.workingDirectory.split(/[\\/]/).includes(".."), `${suite.id}.workingDirectory must stay inside the repository`);
    suites.set(suite.id, suite);
  }
  return suites;
}

function summarizeVitest(stdout, exitCode) {
  if (exitCode !== 0) return { outcome: "fail", total: 1, passed: 0, failed: 1, skipped: 0, executedTests: [] };
  try {
    const marker = stdout.indexOf('{"numTotalTestSuites"');
    const start = marker >= 0 ? marker : stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    const report = JSON.parse(stdout.slice(start, end + 1));
    const summary = {
      total: Number(report.numTotalTests ?? 0),
      passed: Number(report.numPassedTests ?? 0),
      failed: Number(report.numFailedTests ?? 0),
      skipped: Number(report.numPendingTests ?? 0)
    };
    const outcome = summary.failed > 0 ? "fail" : summary.skipped > 0 || summary.total === 0 ? "pending" : "pass";
    const executedTests = Array.isArray(report.testResults)
      ? report.testResults.flatMap((result) => (result.assertionResults ?? []).map((assertion) => ({
        file: result.name,
        id: assertion.title,
        status: assertion.status
      })))
      : [];
    return { outcome, ...summary, executedTests };
  } catch {
    return { outcome: "fail", total: 1, passed: 0, failed: 1, skipped: 0, executedTests: [] };
  }
}

function summarizeNodeTest(stdout, exitCode) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "test:pass") {
        if (event.data?.skip || event.data?.todo) skipped += 1;
        else passed += 1;
      }
      if (event.type === "test:fail") failed += 1;
    } catch {
      // Non-JSON diagnostic output is included in the digest but not counted.
    }
  }
  if (exitCode !== 0 && failed === 0) failed = 1;
  const total = passed + failed + skipped;
  const outcome = failed > 0 ? "fail" : skipped > 0 || total === 0 ? "pending" : "pass";
  return { outcome, total, passed, failed, skipped, executedTests: [] };
}

function summarizeNodeTap(stdout, exitCode) {
  const count = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? 0);
  const summary = { total: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") };
  if (exitCode !== 0 && summary.failed === 0) {
    summary.failed = 1;
    summary.total += 1;
  }
  const outcome = summary.failed > 0 ? "fail" : summary.skipped > 0 || summary.total === 0 ? "pending" : "pass";
  return { outcome, ...summary, executedTests: [] };
}

function summarize(format, stdout, exitCode) {
  if (format === "vitest-json") return summarizeVitest(stdout, exitCode);
  if (format === "node-test-json") return summarizeNodeTest(stdout, exitCode);
  if (format === "node-test-tap") return summarizeNodeTap(stdout, exitCode);
  return { outcome: exitCode === 0 ? "pass" : "fail", total: 1, passed: exitCode === 0 ? 1 : 0, failed: exitCode === 0 ? 0 : 1, skipped: 0, executedTests: [] };
}

async function execute(command, cwd, environment = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env: environment, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ exitCode: code ?? 1, signal: signal ?? null, stdout, stderr }));
  });
}

async function expandReviewedGlobs(command, cwd) {
  const expanded = [];
  for (const part of command) {
    if (!part.endsWith("/*.test.mjs")) {
      expanded.push(part);
      continue;
    }
    const directory = part.slice(0, -"/*.test.mjs".length);
    const files = (await readdir(path.resolve(cwd, directory)))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => `${directory}/${file}`);
    assert.ok(files.length > 0, `reviewed test glob ${part} matched no files`);
    expanded.push(...files);
  }
  return expanded;
}

function normalizeExecutedTests(tests, repositoryRoot, cwd) {
  const root = path.resolve(repositoryRoot);
  const normalized = tests.map((test, index) => {
    exactKeys(test, ["file", "id", "status"], `executed test ${index}`);
    const absolute = path.isAbsolute(test.file) ? path.resolve(test.file) : path.resolve(cwd, test.file);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    assert.ok(relative && relative !== "." && !relative.startsWith("../") && !path.isAbsolute(relative), `executed test file escapes the repository: ${test.file}`);
    assert.match(relative, /\.(?:test|spec)\.(?:ts|tsx|mjs)$/, `executed test file is not a supported test owner: ${relative}`);
    assert.equal(typeof test.id, "string", `executed test ${index}.id must be a string`);
    assert.ok(test.id.trim() && test.id.length <= 512, `executed test ${index}.id is invalid`);
    assert.ok(["passed", "failed", "pending", "skipped", "todo"].includes(test.status), `executed test ${index}.status is invalid`);
    return { file: relative, id: test.id, status: test.status };
  });
  const grouped = new Map();
  for (const test of normalized) {
    const key = `${test.file}\u0000${test.id}`;
    const existing = grouped.get(key);
    const status = test.status === "failed" || existing?.status === "failed"
      ? "failed"
      : test.status === "passed" && (!existing || existing.status === "passed")
        ? "passed"
        : "pending";
    grouped.set(key, { file: test.file, id: test.id, status });
  }
  return [...grouped.values()].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
}

export async function runCandidateSuite({ registry, suiteId, repositoryRoot, candidateSha, workflow, executeCommand = execute, now = () => new Date() }) {
  const suites = suiteMap(registry);
  const suite = suites.get(suiteId);
  assert.ok(suite, `unknown candidate suite ${suiteId}`);
  assert.match(candidateSha ?? "", GIT_SHA, "candidate SHA must be a full lowercase Git SHA");
  const startedAt = now().toISOString();
  const cwd = path.resolve(repositoryRoot, suite.workingDirectory);
  const expandedCommand = await expandReviewedGlobs(suite.command, cwd);
  const result = await executeCommand(expandedCommand, cwd);
  const finishedAt = now().toISOString();
  const summary = summarize(suite.resultFormat, result.stdout, result.exitCode);
  const executedTests = normalizeExecutedTests(
    suite.resultFormat === "vitest-json" ? summary.executedTests : [],
    repositoryRoot,
    cwd
  );
  return {
    receiptVersion: 1,
    receiptType: "candidate-suite",
    generatedBy: "scripts/staging-gate-evidence.mjs",
    suiteId,
    candidateSha,
    commandDigest: digest({ workingDirectory: suite.workingDirectory, command: suite.command, resultFormat: suite.resultFormat }),
    outputDigest: digest(`${result.stdout}\u0000${result.stderr}`),
    startedAt,
    finishedAt,
    exitCode: result.exitCode,
    signal: result.signal,
    outcome: summary.outcome,
    summary: { total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped },
    executedTests,
    workflow
  };
}

function ownerSuites(scenario) {
  const suites = new Map();
  for (const owner of scenario.canonicalOwners) {
    if (owner.file.includes(".staging.spec.")) continue;
    const suiteId = owner.file.startsWith("backend/")
      ? "backend-tests"
      : owner.file.startsWith("client/") ? "client-tests" : owner.file.startsWith("scripts/") ? "repository-tests" : null;
    assert.ok(suiteId, `${scenario.id} has an unsupported candidate owner ${owner.file}`);
    suites.set(suiteId, [...(suites.get(suiteId) ?? []), owner]);
  }
  return new Map([...suites.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function validateSuiteReceipt(receipt, registry, expected = {}) {
  exactKeys(receipt, ["receiptVersion", "receiptType", "generatedBy", "suiteId", "candidateSha", "commandDigest", "outputDigest", "startedAt", "finishedAt", "exitCode", "signal", "outcome", "summary", "executedTests", "workflow"], "suite receipt");
  const suite = suiteMap(registry).get(receipt.suiteId);
  assert.ok(suite, `receipt uses unknown suite ${receipt.suiteId}`);
  assert.equal(receipt.receiptVersion, 1, "receiptVersion must be 1");
  assert.equal(receipt.receiptType, "candidate-suite", "receiptType is invalid");
  assert.equal(receipt.generatedBy, "scripts/staging-gate-evidence.mjs", "receipt producer is invalid");
  assert.match(receipt.candidateSha ?? "", GIT_SHA, "receipt candidate SHA is invalid");
  if (expected.candidateSha) assert.equal(receipt.candidateSha, expected.candidateSha, "receipt candidate SHA differs");
  assert.equal(receipt.commandDigest, digest({ workingDirectory: suite.workingDirectory, command: suite.command, resultFormat: suite.resultFormat }), "receipt command differs from the reviewed registry");
  assert.match(receipt.outputDigest ?? "", SHA256, "receipt output digest is invalid");
  assert.ok(Number.isInteger(receipt.exitCode) && receipt.exitCode >= 0, "receipt exitCode is invalid");
  assert.ok(receipt.signal === null || typeof receipt.signal === "string", "receipt signal is invalid");
  assert.ok(STATUS.has(receipt.outcome), "receipt outcome is invalid");
  exactKeys(receipt.summary, ["total", "passed", "failed", "skipped"], "receipt summary");
  for (const value of Object.values(receipt.summary)) assert.ok(Number.isInteger(value) && value >= 0, "receipt summary values must be non-negative integers");
  assert.equal(receipt.summary.total, receipt.summary.passed + receipt.summary.failed + receipt.summary.skipped, "receipt summary counts do not balance");
  assert.ok(Array.isArray(receipt.executedTests), "receipt executedTests must be an array");
  const normalizedTests = normalizeExecutedTests(receipt.executedTests, "/repository", "/repository");
  assert.deepEqual(receipt.executedTests, normalizedTests, "receipt executedTests must be normalized, sorted, and unique");
  if (receipt.outcome === "pass") {
    assert.equal(receipt.exitCode, 0, "passing receipt requires exit code zero");
    assert.equal(receipt.summary.failed, 0, "passing receipt cannot contain failed tests");
    assert.equal(receipt.summary.skipped, 0, "passing receipt cannot contain skipped tests");
    assert.ok(receipt.summary.total > 0, "passing receipt must contain executed checks");
  }
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), "receipt timestamps are invalid");
  return receipt;
}

export function buildCandidateReport({ registry, receipts, candidateSha, lockfileDigest, workflow, createdAt = new Date().toISOString() }) {
  assert.match(candidateSha ?? "", GIT_SHA, "candidate SHA must be a full lowercase Git SHA");
  assert.match(lockfileDigest ?? "", SHA256, "lockfile digest must be SHA-256");
  const receiptBySuite = new Map();
  for (const receipt of receipts) {
    validateSuiteReceipt(receipt, registry, { candidateSha });
    assert.ok(!receiptBySuite.has(receipt.suiteId), `duplicate receipt for ${receipt.suiteId}`);
    receiptBySuite.set(receipt.suiteId, receipt);
  }
  const requiredSuites = suiteMap(registry);
  const suiteReceipts = [...requiredSuites.keys()].sort().map((suiteId) => {
    const receipt = receiptBySuite.get(suiteId);
    return receipt ? { suiteId, sha256: digest(receipt), outcome: receipt.outcome } : { suiteId, sha256: null, outcome: "pending" };
  });
  const qualityOutcome = suiteReceipts.some((entry) => entry.outcome === "fail") ? "fail" : suiteReceipts.some((entry) => entry.outcome !== "pass") ? "pending" : "pass";
  const scenarioResults = registry.scenarios.map((scenario) => {
    const suites = ownerSuites(scenario);
    assert.ok(suites.size > 0, `${scenario.id} has no candidate test owner`);
    const suiteIds = [...suites.keys()];
    const outcomes = suiteIds.map((suiteId) => receiptBySuite.get(suiteId)?.outcome ?? "pending");
    const missingOwnerTests = [...suites.entries()].flatMap(([suiteId, owners]) => {
      const executed = new Set((receiptBySuite.get(suiteId)?.executedTests ?? []).filter(({ status }) => status === "passed").map(({ file, id }) => `${file}\u0000${id}`));
      return owners.flatMap(({ file, testIds }) => testIds.filter((id) => !executed.has(`${file}\u0000${id}`)).map((id) => ({ file, id })));
    }).sort();
    const status = qualityOutcome === "fail" || outcomes.includes("fail")
      ? "fail"
      : qualityOutcome === "pending" || outcomes.includes("pending") || missingOwnerTests.length > 0 ? "pending" : "pass";
    const ownerTests = [...suites.values()].flatMap((owners) => owners.flatMap(({ file, testIds }) => testIds.map((id) => ({ file, id }))));
    return { id: scenario.id, status, suiteIds, ownerTests, missingOwnerTests };
  });
  return {
    reportVersion: 1,
    reportType: "candidate-scenario-evidence",
    trustMode: "single-owner-procedural",
    generatedBy: "scripts/staging-gate-evidence.mjs",
    registryVersion: registry.registryVersion,
    candidateSha,
    lockfileDigest,
    createdAt,
    workflow,
    suiteReceipts,
    scenarioResults,
    decision: scenarioResults.every(({ status }) => status === "pass") ? "pass" : scenarioResults.some(({ status }) => status === "fail") ? "fail" : "pending"
  };
}

export function validateCandidateReport(report, registry, receipts) {
  exactKeys(report, ["reportVersion", "reportType", "trustMode", "generatedBy", "registryVersion", "candidateSha", "lockfileDigest", "createdAt", "workflow", "suiteReceipts", "scenarioResults", "decision"], "candidate report");
  assert.equal(report.reportVersion, 1, "candidate report version is invalid");
  assert.equal(report.reportType, "candidate-scenario-evidence", "candidate report type is invalid");
  assert.equal(report.trustMode, "single-owner-procedural", "candidate report trust mode is invalid");
  assert.equal(report.generatedBy, "scripts/staging-gate-evidence.mjs", "candidate report producer is invalid");
  assert.equal(report.registryVersion, registry.registryVersion, "candidate report registry version differs");
  const rebuilt = buildCandidateReport({
    registry,
    receipts,
    candidateSha: report.candidateSha,
    lockfileDigest: report.lockfileDigest,
    workflow: report.workflow,
    createdAt: report.createdAt
  });
  assert.deepEqual(report, rebuilt, "candidate report is not derived from the supplied suite receipts");
  return { decision: report.decision, scenarioCount: report.scenarioResults.length, reportDigest: digest(report) };
}

function parseArgs(argv) {
  const command = argv[0];
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0 || !argv[index + 1]) throw new Error(`Use ${flag} <value>`);
    return argv[index + 1];
  };
  return { command, value };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function lockfileDigest(root) {
  const contents = await Promise.all(["backend/package-lock.json", "client/package-lock.json"].map((file) => readFile(path.join(root, file))));
  return digest(Buffer.concat(contents));
}

async function main() {
  const { command, value } = parseArgs(process.argv.slice(2));
  const root = path.resolve(value("--root"));
  const registry = await readJson(path.resolve(root, value("--registry")));
  const candidateSha = value("--candidate-sha");
  const workflowRef = process.env.GITHUB_WORKFLOW_REF?.split("@")[0] ?? "local";
  const workflowMarker = workflowRef.indexOf(".github/workflows/");
  const workflow = {
    repository: process.env.GITHUB_REPOSITORY ?? "local/local",
    workflowFile: workflowMarker >= 0 ? workflowRef.slice(workflowMarker) : workflowRef,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? candidateSha,
    runId: Number(process.env.GITHUB_RUN_ID ?? 1),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    actor: process.env.GITHUB_ACTOR ?? "local"
  };
  if (command === "run-suite") {
    const output = path.resolve(root, value("--output"));
    await mkdir(path.dirname(output), { recursive: true });
    const receipt = await runCandidateSuite({ registry, suiteId: value("--suite"), repositoryRoot: root, candidateSha, workflow });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.outcome !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "build-report") {
    const output = path.resolve(root, value("--output"));
    await mkdir(path.dirname(output), { recursive: true });
    const receiptsDirectory = path.resolve(root, value("--receipts"));
    const receiptFiles = (await readdir(receiptsDirectory)).filter((file) => file.endsWith(".json")).sort();
    const receipts = await Promise.all(receiptFiles.map((file) => readJson(path.join(receiptsDirectory, file))));
    const report = buildCandidateReport({ registry, receipts, candidateSha, lockfileDigest: await lockfileDigest(root), workflow });
    validateCandidateReport(report, registry, receipts);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    if (report.decision !== "pass") process.exitCode = 1;
    return;
  }
  if (command === "verify-report") {
    const receiptsDirectory = path.resolve(root, value("--receipts"));
    const receiptFiles = (await readdir(receiptsDirectory)).filter((file) => file.endsWith(".json")).sort();
    const receipts = await Promise.all(receiptFiles.map((file) => readJson(path.join(receiptsDirectory, file))));
    const report = await readJson(path.resolve(root, value("--report")));
    assert.equal(report.candidateSha, candidateSha, "candidate report SHA differs from the requested candidate");
    assert.equal(report.lockfileDigest, await lockfileDigest(root), "candidate report lockfile digest differs from the candidate checkout");
    const result = validateCandidateReport(report, registry, receipts);
    console.log(JSON.stringify({ event: "staging.gate.candidate.verified", ...result }));
    if (result.decision !== "pass") process.exitCode = 1;
    return;
  }
  throw new Error("Use run-suite, build-report, or verify-report");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "staging.gate.evidence.failed", errorCode: "STAGING_GATE_EVIDENCE_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
