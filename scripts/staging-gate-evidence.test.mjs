import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateReport,
  digest,
  runCandidateSuite,
  validateCandidateReport
} from "./staging-gate-evidence.mjs";

const candidateSha = "a".repeat(40);
const workflow = {
  repository: "clementbowe14/Kapchi",
  workflowFile: ".github/workflows/staging-release-candidate.yml",
  workflowSha: "b".repeat(40),
  runId: 42,
  runAttempt: 1,
  actor: "clementbowe14"
};
const registry = {
  registryVersion: 3,
  candidateSuites: [
    { id: "backend-tests", workingDirectory: "backend", command: ["npm", "test", "--", "--reporter=json"], resultFormat: "vitest-json" },
    { id: "client-tests", workingDirectory: "client", command: ["npm", "test", "--", "--reporter=json"], resultFormat: "vitest-json" },
    { id: "repository-tests", workingDirectory: ".", command: ["node", "--test", "--test-reporter=tap", "scripts/example.test.mjs"], resultFormat: "node-test-tap" }
  ],
  scenarios: [
    { id: "BACKEND", canonicalOwners: [{ file: "backend/src/example.test.ts", testIds: ["backend contract"] }] },
    { id: "CLIENT", canonicalOwners: [{ file: "client/example.test.tsx", testIds: ["client contract"] }] }
  ]
};

function clock() {
  let milliseconds = Date.parse("2026-11-23T12:00:00.000Z");
  return () => new Date(milliseconds += 1_000);
}

async function receipt(suiteId, { skipped = 0, exitCode = 0 } = {}) {
  const suite = registry.candidateSuites.find(({ id }) => id === suiteId);
  const executeCommand = async () => {
    if (suite.resultFormat === "node-test-tap") {
      return {
        exitCode,
        signal: null,
        stdout: `TAP version 13\n1..1\n# tests 1\n# pass ${skipped ? 0 : 1}\n# fail ${exitCode ? 1 : 0}\n# skipped ${skipped}\n`,
        stderr: ""
      };
    }
    const owner = suiteId === "backend-tests" ? "/repo/backend/src/example.test.ts" : "/repo/client/example.test.tsx";
    const title = suiteId === "backend-tests" ? "backend contract" : "client contract";
    return {
      exitCode,
      signal: null,
      stdout: `> kapchi test\n> vitest run --reporter=json\n${JSON.stringify({ numTotalTestSuites: 1, numTotalTests: 1, numPassedTests: skipped || exitCode ? 0 : 1, numFailedTests: exitCode ? 1 : 0, numPendingTests: skipped, testResults: [{ name: owner, assertionResults: [{ title, status: exitCode ? "failed" : skipped ? "pending" : "passed" }] }] })}`,
      stderr: ""
    };
  };
  return runCandidateSuite({ registry, suiteId, repositoryRoot: "/repo", candidateSha, workflow, executeCommand, now: clock() });
}

test("derives a passing report from successful machine receipts", async () => {
  const receipts = await Promise.all(registry.candidateSuites.map(({ id }) => receipt(id)));
  const report = buildCandidateReport({
    registry,
    receipts,
    candidateSha,
    lockfileDigest: "c".repeat(64),
    workflow,
    createdAt: "2026-11-23T12:05:00.000Z"
  });

  assert.equal(report.decision, "pass");
  assert.ok(report.scenarioResults.every(({ status }) => status === "pass"));
  assert.deepEqual(receipts[0].executedTests, [{ file: "backend/src/example.test.ts", id: "backend contract", status: "passed" }]);
  assert.deepEqual(receipts[1].executedTests, [{ file: "client/example.test.tsx", id: "client contract", status: "passed" }]);
  assert.equal(validateCandidateReport(report, registry, receipts).reportDigest, digest(report));
});

test("aggregates repeated parameterized test IDs and requires every instance to pass", async () => {
  const executeCommand = async () => ({
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({
      numTotalTestSuites: 1,
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      testResults: [{
        name: "/repo/backend/src/example.test.ts",
        assertionResults: [
          { title: "backend contract", status: "passed" },
          { title: "backend contract", status: "passed" },
          { title: "backend contract", status: "pending" },
        ],
      }],
    }),
    stderr: "",
  });
  const generated = await runCandidateSuite({
    registry,
    suiteId: "backend-tests",
    repositoryRoot: "/repo",
    candidateSha,
    workflow,
    executeCommand,
    now: clock(),
  });

  assert.deepEqual(generated.executedTests, [{
    file: "backend/src/example.test.ts",
    id: "backend contract",
    status: "pending",
  }]);
  assert.deepEqual(generated.summary, { total: 3, passed: 2, failed: 0, skipped: 1 });
  assert.equal(generated.outcome, "pending");
});

test("keeps failed command fallback summaries balanced", async () => {
  const generated = await runCandidateSuite({
    registry,
    suiteId: "backend-tests",
    repositoryRoot: "/repo",
    candidateSha,
    workflow,
    executeCommand: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "failed" }),
    now: clock(),
  });

  assert.deepEqual(generated.summary, { total: 1, passed: 0, failed: 1, skipped: 0 });
  assert.equal(generated.outcome, "fail");
});

test("preserves failed Vitest identities when the command exits nonzero", async () => {
  const executeCommand = async () => ({
    exitCode: 1,
    signal: null,
    stdout: JSON.stringify({
      numTotalTestSuites: 1,
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [{
        name: "/repo/backend/src/example.test.ts",
        assertionResults: [{ title: "backend contract", status: "failed" }]
      }]
    }),
    stderr: ""
  });
  const generated = await runCandidateSuite({
    registry,
    suiteId: "backend-tests",
    repositoryRoot: "/repo",
    candidateSha,
    workflow,
    executeCommand,
    now: clock()
  });

  assert.deepEqual(generated.summary, { total: 1, passed: 0, failed: 1, skipped: 0 });
  assert.equal(generated.outcome, "fail");
  assert.deepEqual(generated.executedTests, [{
    file: "backend/src/example.test.ts",
    id: "backend contract",
    status: "failed"
  }]);
});

test("keeps malformed Vitest output fallback summaries balanced", async () => {
  const generated = await runCandidateSuite({
    registry,
    suiteId: "backend-tests",
    repositoryRoot: "/repo",
    candidateSha,
    workflow,
    executeCommand: async () => ({ exitCode: 0, signal: null, stdout: "not-json", stderr: "" }),
    now: clock(),
  });

  assert.deepEqual(generated.summary, { total: 1, passed: 0, failed: 1, skipped: 0 });
  assert.equal(generated.outcome, "fail");
});

test("treats skipped required tests as pending", async () => {
  const receipts = [
    await receipt("backend-tests", { skipped: 1 }),
    await receipt("client-tests"),
    await receipt("repository-tests")
  ];
  const report = buildCandidateReport({ registry, receipts, candidateSha, lockfileDigest: "c".repeat(64), workflow });

  assert.equal(receipts[0].outcome, "pending");
  assert.equal(report.decision, "pending");
  assert.ok(report.scenarioResults.every(({ status }) => status === "pending"));
});

test("rejects a handwritten pass that does not match its receipts", async () => {
  const receipts = [
    await receipt("backend-tests", { skipped: 1 }),
    await receipt("client-tests"),
    await receipt("repository-tests")
  ];
  const report = buildCandidateReport({ registry, receipts, candidateSha, lockfileDigest: "c".repeat(64), workflow });
  const forged = structuredClone(report);
  forged.decision = "pass";
  forged.scenarioResults.forEach((scenario) => { scenario.status = "pass"; });

  assert.throws(() => validateCandidateReport(forged, registry, receipts), /not derived/);
});

test("rejects a receipt whose command was changed after review", async () => {
  const generated = await receipt("backend-tests");
  generated.commandDigest = "d".repeat(64);

  assert.throws(
    () => buildCandidateReport({ registry, receipts: [generated], candidateSha, lockfileDigest: "c".repeat(64), workflow }),
    /command differs/
  );
});

test("keeps a scenario pending when its exact owner test ID did not run", async () => {
  const receipts = await Promise.all(registry.candidateSuites.map(({ id }) => receipt(id)));
  receipts[0].executedTests = [{ file: "backend/src/example.test.ts", id: "different contract", status: "passed" }];
  const report = buildCandidateReport({ registry, receipts, candidateSha, lockfileDigest: "c".repeat(64), workflow });
  const backend = report.scenarioResults.find(({ id }) => id === "BACKEND");

  assert.equal(backend.status, "pending");
  assert.deepEqual(backend.missingOwnerTests, [{ file: "backend/src/example.test.ts", id: "backend contract" }]);
  assert.equal(report.decision, "pending");
});

test("rejects duplicate, absolute, and repository-escaping executed test identities", async () => {
  const generated = await receipt("backend-tests");
  for (const tests of [
    [{ file: "backend/src/example.test.ts", id: "backend contract", status: "passed" }, { file: "backend/src/example.test.ts", id: "backend contract", status: "passed" }],
    [{ file: "/tmp/outside.test.ts", id: "backend contract", status: "passed" }],
    [{ file: "../outside.test.ts", id: "backend contract", status: "passed" }]
  ]) {
    const invalid = structuredClone(generated);
    invalid.executedTests = tests;
    assert.throws(
      () => buildCandidateReport({ registry, receipts: [invalid], candidateSha, lockfileDigest: "c".repeat(64), workflow }),
      /executedTests|executed tests|escapes the repository/
    );
  }
});
