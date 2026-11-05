import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceKeys, validateLaunchRecord } from "./validate-launch-record.mjs";

const now = new Date("2026-11-05T18:00:00.000Z");
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function validRecord() {
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
      backendImageDigest: digest,
      workerImageDigest: digest,
      vercelDeploymentId: "dpl_123",
      digitalOceanDeploymentId: "do-deploy-123"
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

test("accepts a complete and consistent GO record", () => {
  assert.equal(validateLaunchRecord(validRecord(), { now }).decision, "GO");
});

test("rejects GO when one check is pending", () => {
  const record = validRecord();
  record.evidence.blob.status = "pending";
  assert.throws(() => validateLaunchRecord(record, { now }), /GO requires blob to pass/);
});

test("rejects release identity drift", () => {
  const record = validRecord();
  record.evidence.migration.releaseSha = "c".repeat(40);
  assert.throws(() => validateLaunchRecord(record, { now }), /differs from the release/);
});

test("rejects stale restore evidence", () => {
  const record = validRecord();
  record.evidence.restoreDrill.checkedAt = "2026-09-01T00:00:00.000Z";
  assert.throws(() => validateLaunchRecord(record, { now }), /restoreDrill evidence is stale/);
});

test("accepts a truthful NO-GO record with a blocker", () => {
  const record = validRecord();
  record.blockers = ["messaging canary did not deliver"];
  record.evidence.messaging.status = "fail";
  record.evidence.decision.value = "NO-GO";
  assert.equal(validateLaunchRecord(record, { now }).decision, "NO-GO");
});
