# Staging Release Gate

This runbook implements the CI, evidence, and release-control portion of issue
#115. It uses a **single-owner procedural** trust model based on exact workflow
and artifact metadata, source digests, and owner review.

The gate is a required repository check. It is not an unbypassable platform
control: the repository owner must not deploy production through another path.

## What Is Implemented

- `staging-release-candidate.yml` runs without repository or provider secrets.
  It provisions temporary PostgreSQL and Redis services, runs every reviewed
  candidate suite once, and uploads seven-day sanitized evidence.
- `staging-release-gate.yml` serializes staging attempts, verifies the candidate
  is reachable from the immutable `main` revision that dispatched the workflow,
  snapshots Vercel deployment and alias state, updates `staging` with a normal
  fast-forward-only push, and invokes the shared Vercel orchestrator to verify
  new Preview deployments and move the stable staging aliases.
- `staging-release-cleanup.yml` runs daily, invokes the Clerk cleanup adapter,
  and fails closed when another provider resource still needs an adapter or
  absence verification.
- A physically separate staging-gate control database, initialized with
  `deploy/staging-gate-control.sql`, stores write-ahead resource intents and
  immutable cleanup tombstones. Application runtime credentials must not have
  access to this database.
- `validate-launch-record.mjs` blocks production `GO` unless the actual final
  issue #115 record is supplied and matches the release.

The credentialed browser, provider-observation, and provider-cleanup adapters
belong to the separate staging-execution workstream. Until they exist, the
staging workflow intentionally ends in failure after Vercel orchestration and
evidence upload. It does not create a final record or issue a `GO` decision.
The fixture runner and Clerk adapter can produce the reviewed customer,
non-admin, and admin identity manifest, but the hosted workflow does not yet
invoke that runner or bind the admin subject in the staging application
database.

## Environment Matrix

| Kapchi environment | Node environment | Provider class |
| --- | --- | --- |
| `local` | `development` or `test` | Local or test |
| `test` | `test` | Fake, local, or test |
| `staging` | `production` | Staging-only test accounts |
| `production` | `production` | Live production accounts |

Vercel deployments must set `KAPCHI_ENVIRONMENT` explicitly. Staging keeps the
same HTTPS, secret length, database pool, CORS, and auth hardening as production
while requiring Stripe and Clerk test credentials and a staging/test database.

## Candidate Evidence

The scenario registry is `deploy/staging-release-scenarios.json`. Every scenario
names exact test files and stable test IDs. Candidate suite commands are also
part of that reviewed registry, so a workflow cannot silently substitute a
different command or accept an unrelated test in the same file.

`staging-gate-evidence.mjs run-suite` executes a registered command and derives
its outcome from the exit code and machine-readable test output. Receipts record
normalized repository-relative test files and exact test IDs. Every non-staging
canonical owner must pass in the matching suite receipt. A skipped or missing
owner is `pending`, not `pass`. The command has no `--status` argument.

`staging-gate-evidence.mjs build-report` recomputes all 25 scenario results from
the suite receipts. The validator rejects a report whose typed statuses differ
from its source receipts. This is reproducible procedural evidence; that
limitation is recorded as `single-owner-procedural`.

## Required Repository Configuration

Configure these GitHub Actions secrets for the credentialed staging workflow:

- `STAGING_VERCEL_TOKEN`
- `STAGING_VERCEL_PROTECTION_BYPASS_SECRET`
- `PRODUCTION_DEPLOYMENT_IDENTITY_HASH`
- `STAGING_GATE_DATABASE_URL`
- `STAGING_GATE_CONTROL_DATABASE_ID`, the 64-character installation identity
  for the physically separate staging-gate control database

Configure these repository variables:

- `STAGING_VERCEL_TEAM_ID`
- `STAGING_VERCEL_STOREFRONT_PROJECT_ID`
- `STAGING_VERCEL_API_PROJECT_ID`
- `STAGING_DEPLOYMENT_IDENTITY_HASH`, the public digest returned by safe release
  identity endpoints
- `STAGING_STOREFRONT_ALIAS`, as an exact HTTPS origin without a trailing slash
- `STAGING_API_ALIAS`, as a different exact HTTPS origin without a trailing slash
- `STAGING_SITE_DOMAIN`, a lowercase multi-label site shared by both direct
  sibling aliases
- `PRODUCTION_STOREFRONT_ORIGIN`, the registered production storefront HTTPS
  origin without a trailing slash
- `PRODUCTION_API_ORIGIN`, the registered production API HTTPS origin without a
  trailing slash
- `VERCEL_OWNER_GITHUB_LOGIN`, the GitHub account linked to the Vercel project
- `VERCEL_OWNER_VERIFIED_EMAIL_SHA256`, SHA-256 of that owner's normalized,
  verified GitHub commit email

Credentialed Playwright execution also requires
`E2E_STAGING_CANDIDATE_SHA` to be the exact lowercase 40-character candidate
SHA. Scenario observations are bound to that SHA and the staging attempt ID.

The staging and production deployment identity hashes must differ. Candidate
commits must be associated by GitHub with the configured owner login and exact
verified-email hash. Never store raw identity values or the email in evidence.

Both Vercel projects must use `production` as the Production Branch. The
`staging` branch is a persistent Preview branch. Configure branch-scoped values
for `KAPCHI_ENVIRONMENT=staging`, `RELEASE_ENVIRONMENT_IDENTITY_MARKER`, and
`RELEASE_SCENARIO_REGISTRY_VERSION`. Do not define those identity keys as
general Preview or Production values. General Preview variables must not contain
production credentials. The API project must be public at the Vercel layer;
Fastify still protects application routes. The storefront Preview remains
protected and is probed with the bypass secret only on its exact expected host.

## Running the Candidate Suite

The candidate workflow runs automatically for pull requests and `main`. Before
dispatching the credentialed gate:

1. Confirm the candidate workflow completed successfully.
2. Record its GitHub run ID and exact 40-character commit SHA.
3. Confirm the SHA is already merged into and reachable from `main`.
4. Select `main`, dispatch **Staging release gate**, and type
   `ADVANCE_STAGING`.

The workflow downloads candidate evidence from the named run and verifies its
SHA and derived decision. Missing evidence or settings stop the run before the
branch moves. The dispatch is rejected unless both `github.ref` and the workflow
reference identify `main`; checkout uses the immutable workflow SHA with
persisted credentials disabled.

The Vercel integration uses this backend command contract from `backend/`:

```text
npm run staging:vercel -- snapshot --attempt-id ID --candidate-sha SHA --output-dir DIR
npm run staging:vercel -- prepare  --attempt-id ID --candidate-sha SHA --output-dir DIR --snapshot FILE
npm run staging:vercel -- verify   --attempt-id ID --candidate-sha SHA --output-dir DIR --manifest FILE
npm run staging:vercel -- recover  --attempt-id ID --candidate-sha SHA --output-dir DIR
```

Credentials, identifiers, origins, and aliases are environment variables, never
command-line arguments. The workflow writes artifacts under
`.staging-gate/vercel`. `snapshot.json`, `attempt-report.json`,
`recovery-summary.json`, and an optional `verification-receipt.json` upload even
when orchestration fails. `staging-deployment-manifest.json` uploads only after
successful preparation and read-back. The workflow then deliberately exits
nonzero because issues #139 and #140 still block final release-gate execution.

## Staging Branch Safety

The gate uses one repository-wide concurrency group with cancellation disabled.
Before Git mutation, `snapshot` records deployment IDs and verified, recoverable
alias baselines. The workflow then fetches the current `staging` branch and
proves that it is an ancestor of the candidate. The subsequent ordinary Git
push rejects non-fast-forward history. The workflow never force-pushes. Git
authentication exists only in that step through a temporary askpass helper and
is removed when the step exits.

The orchestrator requires both Vercel projects' Production Branch to be exactly
`production`, validates their repository links and branch-scoped environment
metadata, and denies registered production domains before an alias can move.
Only deployments absent from the pre-push snapshot and bound to the exact
candidate SHA and `staging` ref are eligible.

The job records absolute deadlines at startup: preparation ends by minute 115,
recovery ends by minute 130, artifact handling retains minutes 130 through 135,
and GitHub terminates the job at minute 135. Backend orchestration must honor the
exported `STAGING_GATE_*_DEADLINE_EPOCH` values rather than starting a fresh
relative timeout.

## Resource Intent and Cleanup

Create a physically separate control database with
`deploy/staging-gate-control.sql` and use an identity dedicated to trusted
workflows. Do not grant the deployed application identity access to that
database.

Apply the control schema again when upgrading to issue #138 so the durable
`alias_intents` table and terminal-intent protection trigger exist before the
workflow runs. `STAGING_GATE_DATABASE_URL` must use authenticated TLS with
`sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`; plaintext and
certificate-bypass modes are rejected before connecting.

Before a provider mutation, insert `creation-pending` with:

- attempt ID and deterministic namespace;
- idempotency key;
- expected staging account and project hashes;
- intent timestamp and 24-hour attempt expiry.

Only after the intent commits may the provider call begin. Bind the returned
handle hash before using the resource. Cleanup may act only on a bound resource
or a pending intent reconciled against the same account, project, namespace,
attempt, and creation window.

Deletable resources pass only after absence verification. Stripe and messaging
objects may pass as `terminal-isolated` only after their safe terminal state is
verified. Cleaned tombstones cannot be changed and may be purged after 30 days
only when an evidence digest is present.

The current scheduled workflow can reconcile and delete attempt-owned Clerk
identities. It fails if Blob, Stripe, messaging, or another resource still
requires a provider adapter or absence verification. That red failure is an
operator action item, not a successful cleanup result.

## Final Record

Version 2 final records use
`docs/runbooks/templates/staging-gate-record.json`. The validator requires:

- the exact workflow, actor, run, candidate SHA, lockfile digest, and registry;
- different staging and production deployment credential identities;
- immutable storefront/API staging deployment IDs and URLs;
- stable, distinct, same-site aliases still targeting those deployments;
- candidate, staging, provider, log-scan, and cleanup report digests;
- artifact ID, URL, repository, workflow file/SHA, run ID/attempt, and candidate
  SHA bindings for every report;
- scenario statuses derived from the supplied reports;
- verified terminal cleanup with no blockers; and
- a decision recomputed by `validate-staging-gate.mjs`.

The template is always `NO-GO`. Replacing placeholders does not make it
evidence. A real final record can exist only after the staging-execution
workstream supplies all source reports.

## Production Launch Binding

A production launch record includes the final #115 record digest, attempt,
candidate SHA, lockfile digest, registry version, expiry, and staging deployment
IDs. Validate it with:

```bash
node scripts/validate-launch-record.mjs \
  --record path/to/launch-record.json \
  --staging-gate-bundle path/to/staging-gate-bundle \
  --staging-gate-registry deploy/staging-release-scenarios.json
```

The bundle must contain the downloaded, verified source evidence at these
paths:

```text
record.json
candidate/report.json
candidate/receipts/*.json
staging/report.json
staging/observations.json
provider/report.json
provider/observations.json
logs/sanitized.ndjson
logs/canaries.json
logs/report.json
cleanup/report.json
cleanup/export.json
artifacts/verifications.json
artifacts/candidate/archive.zip
artifacts/candidate/contents/**
artifacts/staging/archive.zip
artifacts/staging/contents/**
artifacts/provider/archive.zip
artifacts/provider/contents/**
artifacts/logScan/archive.zip
artifacts/logScan/contents/**
artifacts/cleanup/archive.zip
artifacts/cleanup/contents/**
```

The validator hashes each downloaded archive and every extracted file itself.
It rejects evidence when those computed digests differ from the artifact
metadata bound into the final record; `artifacts/verifications.json` is not
trusted as a digest oracle.

Validate the staging bundle directly with
`node scripts/validate-staging-gate.mjs --bundle <directory> --registry
deploy/staging-release-scenarios.json`. Legacy individual report flags are not
accepted because they cannot supply all independently recomputed evidence.

`logs/canaries.json` contains only the fixed canary bundle deterministically
derived from the attempt ID and candidate SHA. Arbitrary operator strings,
customer data, filenames, addresses, and tokens are rejected. The cleanup
export uses contract version 2 and must contain a non-empty expected resource
inventory that exactly matches its control-ledger records. Empty, missing, or
unexpected inventories fail closed and cannot produce `GO`.

Production `GO` is rejected when the #115 record is absent, stale, not `GO`, has
unverified cleanup, contains blockers, differs from the release, or reuses a
staging deployment ID as a production deployment ID.

## Operator-Only Blockers

A real end-to-end gate remains blocked until the owner supplies staging-only
Vercel, database, Stripe, Clerk, Blob, Redis, messaging, and bypass credentials;
stable aliases; production identity denylist hashes; and a Vercel plan approved
for Kapchi's commercial production use. The hosted workflow must still add the
fixture-manifest generator, provider observations, sanitized log export, and
Blob/Stripe/messaging cleanup adapters before it may create a final `GO` record.
Code must never invent these values.
