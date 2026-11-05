#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
const providerReference = /^(?:https:\/\/|vercel:\/\/|digitalocean:\/\/|stripe:\/\/|clerk:\/\/|betterstack:\/\/)/;
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

export function validateLaunchRecord(record, { now = new Date(), template = false } = {}) {
  assert.equal(record.recordVersion, 1, "recordVersion must be 1");
  assert.match(record.release?.sha ?? "", /^[0-9a-f]{40}$/i, "release.sha must be a full Git SHA");
  assert.match(record.release?.backendImageDigest ?? "", /^sha256:[0-9a-f]{64}$/i, "backend image digest is invalid");
  assert.match(record.release?.workerImageDigest ?? "", /^sha256:[0-9a-f]{64}$/i, "worker image digest is invalid");
  assert.equal(record.release.backendImageDigest, record.release.workerImageDigest, "API and worker must use the same image digest");
  assert.ok(String(record.release.vercelDeploymentId ?? "").trim(), "Vercel deployment ID is required");
  assert.ok(String(record.release.digitalOceanDeploymentId ?? "").trim(), "DigitalOcean deployment ID is required");

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
  return { recordPath: argv[recordIndex + 1], template: argv.includes("--template") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = JSON.parse(await readFile(args.recordPath, "utf8"));
  const result = validateLaunchRecord(record, { template: args.template });
  console.log(JSON.stringify({ event: "launch.record.validated", ...result }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "launch.record.invalid", errorCode: "LAUNCH_RECORD_INVALID", reason: error.message }));
    process.exitCode = 1;
  });
}
