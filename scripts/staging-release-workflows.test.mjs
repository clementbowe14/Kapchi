import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const candidate = read(".github/workflows/staging-release-candidate.yml");
const gate = read(".github/workflows/staging-release-gate.yml");
const migration = read("deploy/staging-gate-control.sql");

const count = (source, pattern) => [...source.matchAll(pattern)].length;
const between = (source, start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
};

test("pins upload-artifact v4 to the official immutable commit", () => {
  assert.match(candidate, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4/);
  assert.doesNotMatch(candidate, /actions\/upload-artifact@v4/);
  assert.match(candidate, /path: \.staging-gate\/\s+if-no-files-found: error\s+include-hidden-files: true/);
});

test("fails an incorrect confirmation instead of skipping the gate", () => {
  assert.doesNotMatch(gate, /^\s+if:\s*inputs\.confirmation/m);
  assert.match(gate, /test "\$\{CONFIRMATION\}" = "ADVANCE_STAGING"/);
});

test("runs only the immutable workflow revision dispatched from main", () => {
  assert.match(gate, /DISPATCH_REF: \$\{\{ github\.ref \}\}/);
  assert.match(gate, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/);
  assert.match(gate, /test "\$\{DISPATCH_REF\}" = "refs\/heads\/main"/);
  assert.match(gate, /staging-release-gate\.yml@refs\/heads\/main/);
  assert.match(gate, /TRUSTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(gate, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(gate, /persist-credentials: false/);
  assert.match(gate, /git merge-base --is-ancestor "\$\{CANDIDATE_SHA\}" "\$\{TRUSTED_WORKFLOW_SHA\}"/);
  assert.doesNotMatch(gate, /ref: main/);
});

test("serializes attempts and reserves an absolute 135-minute budget", () => {
  assert.match(gate, /group: staging-release-gate\s+cancel-in-progress: false/);
  assert.match(gate, /timeout-minutes: 135/);
  assert.match(gate, /STAGING_GATE_PREPARE_DEADLINE_EPOCH=\$\(\(started_at_epoch \+ 6900\)\)/);
  assert.match(gate, /STAGING_GATE_RECOVERY_DEADLINE_EPOCH=\$\(\(started_at_epoch \+ 7800\)\)/);
  assert.match(gate, /STAGING_GATE_EVIDENCE_DEADLINE_EPOCH=\$\(\(started_at_epoch \+ 8100\)\)/);
  assert.match(gate, /remaining_seconds=\$\(\(STAGING_GATE_PREPARE_DEADLINE_EPOCH - \$\(date \+%s\)\)\)/);
  assert.match(gate, /remaining_seconds=\$\(\(STAGING_GATE_RECOVERY_DEADLINE_EPOCH - \$\(date \+%s\)\)\)/);
  assert.equal(count(gate, /timeout --signal=TERM --kill-after=30s "\$\{remaining_seconds\}s"/g), 2);
});

test("keeps credentials step-scoped and separates Git from Vercel access", () => {
  const jobEnvironment = between(gate, "    env:\n", "    steps:\n");
  assert.doesNotMatch(jobEnvironment, /secrets\./);
  assert.equal(count(gate, /STAGING_VERCEL_TOKEN: \$\{\{ secrets\.STAGING_VERCEL_TOKEN \}\}/g), 3);
  assert.equal(count(gate, /STAGING_VERCEL_PROTECTION_BYPASS_SECRET: \$\{\{ secrets\.STAGING_VERCEL_PROTECTION_BYPASS_SECRET \}\}/g), 3);
  assert.equal(count(gate, /PRODUCTION_DEPLOYMENT_IDENTITY_HASH: \$\{\{ secrets\.PRODUCTION_DEPLOYMENT_IDENTITY_HASH \}\}/g), 3);
  assert.equal(count(gate, /STAGING_GATE_DATABASE_URL: \$\{\{ secrets\.STAGING_GATE_DATABASE_URL \}\}/g), 3);
  assert.equal(count(gate, /STAGING_GATE_CONTROL_DATABASE_ID: \$\{\{ secrets\.STAGING_GATE_CONTROL_DATABASE_ID \}\}/g), 3);
  assert.equal(count(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/g), 3);
  const pushStep = between(
    gate,
    "      - name: Fast-forward staging branch with isolated Git credentials",
    "      - name: Prepare immutable Vercel staging deployments and aliases",
  );
  assert.match(pushStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(pushStep, /STAGING_VERCEL_TOKEN|STAGING_GATE_DATABASE_URL/);
  assert.doesNotMatch(gate, /https:\/\/x-access-token:/);
});

test("passes the backend's exact noncredential environment contract", () => {
  assert.match(gate, /ATTEMPT_ID: stg_\$\{\{ github\.run_id \}\}_\$\{\{ github\.run_attempt \}\}/);
  assert.match(gate, /STAGING_VERCEL_TEAM_ID: \$\{\{ vars\.STAGING_VERCEL_TEAM_ID \}\}/);
  assert.match(gate, /STAGING_VERCEL_STOREFRONT_PROJECT_ID: \$\{\{ vars\.STAGING_VERCEL_STOREFRONT_PROJECT_ID \}\}/);
  assert.match(gate, /STAGING_VERCEL_API_PROJECT_ID: \$\{\{ vars\.STAGING_VERCEL_API_PROJECT_ID \}\}/);
  assert.match(gate, /TRUSTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(gate, /^\s+(?:VERCEL_TEAM_ID|STOREFRONT_PROJECT_ID|API_PROJECT_ID):/m);
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
  assert.match(gate, /u\.origin!==raw/);
  assert.match(gate, /u\.hostname\.split\("\."\)\.length===labels\+1/);
  assert.match(gate, /a\.hostname===b\.hostname/);
  assert.match(gate, /PRODUCTION_STOREFRONT_ORIGIN/);
  assert.match(gate, /PRODUCTION_API_ORIGIN/);
  assert.match(gate, /\[p\.hostname,q\.hostname\]\.includes\(a\.hostname\)/);
});

test("keeps hosted execution truthfully blocked", () => {
  assert.match(gate, /issues #139 and #140 still block the final release gate/);
  assert.match(gate, /No final gate record was created, no GO decision was issued, and production remains blocked/);
  assert.match(gate, /exit 1/);
});

test("snapshots before the isolated fast-forward push and prepares afterward", () => {
  const snapshotIndex = gate.indexOf("npm run staging:vercel -- snapshot");
  const pushIndex = gate.indexOf("git push --porcelain");
  const prepareIndex = gate.indexOf("npm run staging:vercel -- prepare");
  assert.ok(snapshotIndex >= 0);
  assert.ok(snapshotIndex < pushIndex);
  assert.ok(pushIndex < prepareIndex);
  assert.match(gate, /git fetch --no-tags .* refs\/heads\/staging:refs\/remotes\/origin\/staging/);
  assert.match(gate, /git merge-base --is-ancestor refs\/remotes\/origin\/staging "\$\{CANDIDATE_SHA\}"/);
  assert.match(gate, /"\$\{CANDIDATE_SHA\}:refs\/heads\/staging"/);
  assert.match(gate, /GIT_ASKPASS/);
  assert.match(gate, /GIT_TERMINAL_PROMPT=0/);
  assert.doesNotMatch(gate, /git push[^\n]*(?:--force|-f\b|force-with-lease)/);
  assert.doesNotMatch(gate, /(?:--prod|target[=:]production)/i);
});

test("uses the shared backend orchestration command contract", () => {
  for (const mode of ["snapshot", "prepare", "recover"]) {
    const command = new RegExp(`npm run staging:vercel -- ${mode}[\\s\\S]*?--attempt-id "\\$\\{ATTEMPT_ID\\}"[\\s\\S]*?--candidate-sha "\\$\\{CANDIDATE_SHA\\}"[\\s\\S]*?--output-dir "\\$\\{GITHUB_WORKSPACE\\}/\\.staging-gate/vercel"`);
    assert.match(gate, command);
  }
  assert.match(gate, /npm run staging:vercel -- prepare[\s\S]*?--snapshot "\$\{GITHUB_WORKSPACE\}\/\.staging-gate\/vercel\/snapshot\.json"/);
  assert.doesNotMatch(gate, /--(?:token|team-id|project-id|alias|database-url|bypass-secret)\b/);
});

test("always recovers and uploads redacted evidence but gates the success manifest", () => {
  const recoverStep = between(
    gate,
    "      - name: Reconcile aliases and flush recovery evidence",
    "      - name: Upload redacted Vercel attempt and recovery evidence",
  );
  assert.match(recoverStep, /if: always\(\)/);
  assert.match(recoverStep, /npm run staging:vercel -- recover/);

  const evidenceStep = between(
    gate,
    "      - name: Upload redacted Vercel attempt and recovery evidence",
    "      - name: Upload verified staging deployment manifest",
  );
  assert.match(evidenceStep, /if: always\(\)/);
  assert.match(evidenceStep, /attempt-report\.json/);
  assert.match(evidenceStep, /recovery-summary\.json/);
  assert.doesNotMatch(evidenceStep, /staging-deployment-manifest\.json/);

  const manifestStep = between(
    gate,
    "      - name: Upload verified staging deployment manifest",
    "      - name: Stop before final release-gate execution",
  );
  assert.match(manifestStep, /if: success\(\)/);
  assert.match(manifestStep, /staging-deployment-manifest\.json/);
  assert.match(manifestStep, /if-no-files-found: error/);
});

test("pins every third-party action to an immutable commit", () => {
  const actions = [...gate.matchAll(/^\s+uses: ([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actions.length >= 4);
  for (const action of actions) {
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/);
  }
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

test("persists immutable crash-recovery intents for Vercel alias mutations", () => {
  assert.match(migration, /create table if not exists staging_gate_control\.alias_intents/);
  assert.match(migration, /state text not null default 'pending' check \(state in \('pending', 'complete', 'restored'\)\)/);
  assert.match(migration, /protect_terminal_alias_intent/);
  assert.match(migration, /staging_gate_alias_intent_terminal_immutable/);
  assert.match(migration, /state <> 'complete' or \(storefront_assigned_at is not null and api_assigned_at is not null\)/);
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
