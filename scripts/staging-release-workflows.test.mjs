import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const candidate = read(".github/workflows/staging-release-candidate.yml");
const gate = read(".github/workflows/staging-release-gate.yml");
const migration = read("deploy/staging-gate-control.sql");

test("pins upload-artifact v4 to the official immutable commit", () => {
  assert.match(candidate, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4/);
  assert.doesNotMatch(candidate, /actions\/upload-artifact@v4/);
  assert.match(candidate, /path: \.staging-gate\/\s+if-no-files-found: error\s+include-hidden-files: true/);
});

test("fails an incorrect confirmation instead of skipping the gate", () => {
  assert.doesNotMatch(gate, /^\s+if:\s*inputs\.confirmation/m);
  assert.match(gate, /test "\$\{CONFIRMATION\}" = "ADVANCE_STAGING"/);
});

test("fails closed on candidate owner login and verified-email hash", () => {
  assert.match(gate, /VERCEL_OWNER_GITHUB_LOGIN: \$\{\{ vars\.VERCEL_OWNER_GITHUB_LOGIN \}\}/);
  assert.match(gate, /VERCEL_OWNER_VERIFIED_EMAIL_SHA256: \$\{\{ vars\.VERCEL_OWNER_VERIFIED_EMAIL_SHA256 \}\}/);
  assert.match(gate, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{CANDIDATE_SHA\}"/);
  assert.match(gate, /author_login.*VERCEL_OWNER_GITHUB_LOGIN/);
  assert.match(gate, /email_hash.*VERCEL_OWNER_VERIFIED_EMAIL_SHA256/);
});

test("requires exact direct-sibling HTTPS staging aliases", () => {
  assert.match(gate, /const dns=\/\^\(\?:\[a-z0-9\]/);
  assert.match(gate, /u\.origin===u\.href\.replace/);
  assert.match(gate, /u\.hostname\.split\("\."\)\.length===labels\+1/);
  assert.match(gate, /a\.hostname===b\.hostname/);
});

test("keeps hosted execution truthfully blocked", () => {
  assert.match(gate, /No final gate record was created and production remains blocked/);
  assert.match(gate, /exit 1/);
});

test("downloads one exact artifact and recomputes report, archive, and content evidence", () => {
  assert.match(gate, /artifact_count.*-eq 1/);
  assert.match(gate, /actions\/artifacts\/\$\{artifact_id\}\/zip/);
  assert.match(gate, /verify-staging-artifact\.mjs/);
  assert.match(gate, /staging-gate-evidence\.mjs verify-report/);
  assert.doesNotMatch(gate, /jq -r \.decision/);
});

test("allows multiple resources per namespace while retaining idempotency uniqueness", () => {
  assert.match(migration, /unique \(provider, idempotency_key\)/);
  assert.doesNotMatch(migration, /unique \(attempt_id, provider, namespace\)/);
  assert.match(migration, /create index if not exists staging_gate_resource_intents_attempt_provider_namespace\s+on staging_gate_control\.resource_intents \(attempt_id, provider, namespace\)/);
});

test("boots a dedicated disposable control database for ledger integration coverage", () => {
  assert.match(candidate, /RUN_DATABASE_INTEGRATION_TESTS: "true"/);
  assert.match(candidate, /STAGING_GATE_CONTROL_DATABASE_ID:/);
  assert.match(candidate, /STAGING_GATE_DATABASE_URL=/);
  assert.match(candidate, /create database kapchi_staging_gate_test/);
  assert.match(candidate, /--file=deploy\/staging-gate-control\.sql/);
});

test("authorizes catalog setup and preserves evidence when setup fails", () => {
  assert.match(candidate, /KAPCHI_FIXTURE_CONFIRM_DATABASE: kapchi_test/);
  assert.match(candidate, /KAPCHI_FIXTURE_DATABASE_TOKEN: candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(candidate, /db:fixtures:seed-integration-catalog/);
  assert.match(candidate, /\{"outcome":"pending","stage":"candidate-setup"\}/);
  assert.match(candidate, /\{"outcome":"pass","stage":"candidate-setup"\}/);
  assert.ok(
    candidate.indexOf("Initialize candidate evidence") <
      candidate.indexOf("Seed isolated integration catalog"),
  );
});
