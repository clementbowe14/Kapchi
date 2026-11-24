# Issue #138: Immutable Vercel Staging Orchestration

Status: approved for implementation on 2026-11-24

Parent: #115

Depends on: PR #136 staging release-gate foundation

Review boundary: Vercel deployment, identity, alias, and deployment-evidence orchestration only

Review record: three independent reviews covered security and trust boundaries,
Vercel operations and recovery, and testability and integration boundaries. Each
initial review required changes. This revision incorporates their findings,
including durable restart recovery, immutable-main execution, current-attempt
deployment selection, production-domain denial, runtime identity proofs,
hardened probes, queue-aware deadlines, post-window verification, and expanded
failure tests. The owner then explicitly authorized implementation against this
revised specification.

## Purpose

Issue #138 replaces the intentional stop in the staging release-gate workflow
with fail-closed Vercel orchestration. It advances the persistent `staging`
branch to an approved candidate, observes only deployments created by that
advancement, proves that both are ready Preview deployments of the exact commit
in the expected projects, and only then moves the stable staging aliases.

This issue does not create scenario fixtures, run browser scenarios, collect
Stripe or Clerk evidence, clean provider resources, or issue the final `GO`
decision. Those responsibilities remain in #139, #140, and parent issue #115.
A successful run emits a verified deployment manifest for those later stages;
it never claims that the complete release gate passed.

## User Outcome

An authorized operator dispatches the trusted workflow from `main` with a full
SHA already reachable from `main`. The workflow either:

- routes both staging aliases to newly created, ready, identity-verified Preview
  deployments of that SHA and emits redacted evidence; or
- stops with a stable error, conditionally restores aliases changed by the
  attempt, and emits no success manifest.

Uncertainty is failure. The workflow never guesses which deployment, project,
branch, environment, repository, or alias target is correct.

## Fixed Topology

- The storefront and Fastify API are separate Vercel projects linked to this
  GitHub repository.
- Both projects have `production` as their Vercel Production Branch.
- The persistent `staging` branch creates Preview deployments with staging-only,
  branch-scoped variables.
- The storefront Preview uses Vercel Deployment Protection. Its probes send the
  bypass value only as a header and never follow redirects.
- The API Preview is public at the Vercel layer so providers can reach it.
  Fastify continues to authenticate application routes and verify provider
  signatures. `/health` and `/ready` are the only orchestration probes that are
  intentionally public.
- Stable staging aliases are runtime routing names, not identity evidence.
  Deployment IDs, immutable Vercel hostnames, provider metadata, and release
  responses establish identity.

## Inputs And Configuration

The trusted workflow keeps its existing inputs:

- `candidate_sha`: full lowercase 40-character SHA reachable from `main`;
- `candidate_run_id`: successful candidate workflow run for that SHA; and
- `confirmation`: exact `ADVANCE_STAGING` operator confirmation.

Step-scoped GitHub secrets are:

- `STAGING_VERCEL_TOKEN`;
- `STAGING_VERCEL_PROTECTION_BYPASS_SECRET`;
- `PRODUCTION_DEPLOYMENT_IDENTITY_HASH`; and
- `STAGING_GATE_DATABASE_URL`, used by the external control ledger; and
- `STAGING_GATE_CONTROL_DATABASE_ID`, the expected 64-character installation
  identity of that physically separate control plane.

Noncredential identifiers are GitHub variables and may appear in redacted
evidence:

- `STAGING_VERCEL_TEAM_ID`;
- `STAGING_VERCEL_STOREFRONT_PROJECT_ID`;
- `STAGING_VERCEL_API_PROJECT_ID`;
- `STAGING_DEPLOYMENT_IDENTITY_HASH`, which is intentionally returned by safe
  release endpoints and is not a credential;
- `STAGING_STOREFRONT_ALIAS`;
- `STAGING_API_ALIAS`;
- `STAGING_SITE_DOMAIN`;
- `PRODUCTION_STOREFRONT_ORIGIN`;
- `PRODUCTION_API_ORIGIN`;
- `VERCEL_OWNER_GITHUB_LOGIN`; and
- `VERCEL_OWNER_VERIFIED_EMAIL_SHA256`.

Aliases and production origins are HTTPS origins. Validation rejects credentials,
paths, queries, fragments, ports, non-HTTPS schemes, duplicate hosts, hosts
outside the configured staging site, and staging hosts equal to either production
host.

### Runtime environment identity

Each Vercel project has branch-scoped `staging` values for:

- `KAPCHI_ENVIRONMENT=staging`;
- `RELEASE_ENVIRONMENT_IDENTITY_MARKER`; and
- `RELEASE_SCENARIO_REGISTRY_VERSION`.

The raw marker is random and never leaves Vercel. The deployed application
exposes only:

```text
sha256("kapchi-deployment-identity:v1:" + RELEASE_ENVIRONMENT_IDENTITY_MARKER)
```

The digest must equal `STAGING_DEPLOYMENT_IDENTITY_HASH` and differ from
`PRODUCTION_DEPLOYMENT_IDENTITY_HASH`. The scenario version must equal
`registryVersion` in the candidate's reviewed
`deploy/staging-release-scenarios.json`.

The storefront `/api/release`, API `/health`, and API `/ready` return the safe
identity fields: full release SHA, Vercel deployment ID, `KAPCHI_ENVIRONMENT`,
environment identity digest, and scenario registry version. No raw marker,
credential, provider account ID, or private URL is exposed.

## Trust And Credential Boundaries

1. The workflow rejects dispatch unless `github.ref` is `refs/heads/main` and
   its workflow reference identifies the reviewed workflow on `main`.
2. It records the dispatch's `github.sha` as the immutable workflow SHA and
   checks out that SHA, not the moving `main` ref.
3. Candidate code is read with `git show` and deployed by Vercel, but never
   executed in the credentialed orchestration process.
4. `actions/checkout` uses `persist-credentials: false`. The GitHub token is
   exposed only to the fast-forward push step; Vercel credentials are exposed
   only to snapshot, preparation, verification, and recovery steps.
5. Vercel management credentials are never available to either deployed app,
   candidate tests, checkout, artifact upload, or arbitrary shell steps.
6. Remote actions are pinned to immutable commit SHAs and workflow permissions
   remain least privilege.

## Preflight Invariants

Before branch or alias mutation, orchestration verifies:

- the existing candidate artifact, author, email, exact-SHA, and reachability
  controls from PR #136;
- both Vercel project IDs are distinct, owned by the configured team, linked to
  this exact GitHub repository ID/owner/name, and use Production Branch
  `production`;
- each configured production origin is registered by Vercel as a production
  domain of its expected storefront or API project; a caller-provided hostname
  alone is never trusted as the production denylist;
- Git deployments are enabled for `staging`;
- environment-variable metadata contains the three required identity keys scoped
  to Preview branch `staging`, with no general Preview or production-targeted
  entry for those keys;
- the storefront project has deployment protection and the API does not return a
  Vercel protection challenge;
- expected staging and production identity digests differ;
- staging aliases are same-site siblings and match neither production hostname;
  and
- each staging alias already points to one ready `staging` Preview deployment in
  its expected project with a valid staging release identity.
- the control database connection uses authenticated TLS, its control-plane row
  matches `STAGING_GATE_CONTROL_DATABASE_ID`, environment `staging`, and purpose
  `kapchi-staging-release-gate`.

An unassigned alias is not bootstrapped by this workflow because it has no safe
rollback target. Initial alias setup is an explicit owner operation.

## Components

### Typed Vercel client

Add a narrow client under `backend/src/scripts/staging-gate/` for:

- project, Git linkage, environment metadata, and protection configuration;
- deployment listing and deployment-by-ID lookup;
- alias lookup and assignment; and
- bounded immutable and aliased HTTP probes.

The client uses `https://api.vercel.com`, bearer authentication, and `teamId` on
team-scoped calls. Runtime validators normalize provider payloads and reject
missing or incorrectly typed fields. Errors expose stable internal codes, safe
HTTP status, operation, and retry count, but never tokens, headers, bypass
values, or raw response bodies.

All probe URLs are constructed from already validated exact HTTPS hosts and
fixed paths. Fetch uses `redirect: "manual"`, a 64 KiB response limit, required
JSON content type, and `cache: "no-store"`. Any redirect is failure. The
storefront bypass header is sent only to the exact immutable or stable storefront
host and is never sent to the API.

### Orchestration command

One command exposes four modes using shared validators:

- `snapshot`: records project deployment IDs and verified alias baselines before
  the branch push;
- `prepare`: discovers new deployments, verifies them, switches aliases, and
  emits the success manifest;
- `verify`: non-mutating revalidation of a success manifest; and
- `recover`: idempotent reconciliation of an unfinished alias intent.

The later #139/#140 stages call `verify` after their test window and immediately
before finalization. They do not duplicate Vercel logic or gain alias mutation
authority.

## Lifecycle

1. Reconcile any unfinished alias intent in the external control ledger. The run
   stops if recovery is uncertain or incomplete.
2. Run preflight and write a snapshot containing the attempt ID, candidate SHA,
   timestamp, current deployment IDs, and verified prior alias targets.
3. Fast-forward `staging` to the candidate. Never force-push, use `--prod`, or
   request a Production deployment.
4. Observe both projects for matching deployments absent from the snapshot and
   created no earlier than its timestamp. A single Git push may trigger both
   projects while Vercel Hobby queues one build, so both are observed without
   assuming concurrent or sequential start times.
5. Require each selected deployment to be ready and verify its immutable release
   response. Verify API `/ready`, and call API `/orders/me` without credentials
   or a bypass header; it must return `401` or `403` rather than application data
   or a Vercel protection response.
6. Re-read both deployments and alias baselines. Abort on any drift.
7. In the external control database, durably record a pre-mutation alias intent,
   both prior targets, both requested targets, project IDs, attempt ID, and
   candidate SHA before the first assignment.
8. Assign and read back the storefront alias, then assign and read back the API
   alias. Mark each completed mutation in the ledger.
9. Verify both aliases through Vercel and their HTTP identity endpoints.
10. Atomically write and read back the complete success manifest while the
    durable intent remains unfinished. Then mark the intent complete. A manifest
    is uploaded only if both operations succeed and the command exits zero; a
    manifest-write or ledger-finalization failure invokes recovery.

If `staging` already equals the candidate, `prepare` still refuses every
deployment present in the snapshot. If Vercel creates no new deployment, the
run fails with `NO_NEW_DEPLOYMENT`. An old deployment is never silently reused
after environment or project settings may have changed.

## Deterministic Deployment Selection

A matching deployment must:

- be absent from the pre-push snapshot and have a creation time at or after it;
- belong to the expected team and project;
- report the full candidate SHA and Git ref `staging`;
- report Preview, never Production, as its environment/target;
- reach ready state; and
- use an immutable Vercel deployment hostname, not a stable alias.

More than one match is allowed because Git delivery or Vercel may retry. The
orchestrator inspects every new match and selects the most recent ready one. A
failed duplicate does not override a ready duplicate. The run fails when every
matching deployment is terminally failed with none queued/building, or when the
overall deadline expires. Wrong project, SHA, ref, or target entries are
ineligible and summarized without leaking private URLs.

## Alias Recovery

Before mutation, prior targets must independently satisfy the same project,
Preview, `staging`, ready-state, runtime environment identity, and
production-host-denylist checks as new targets. The durable control ledger, not
the runner filesystem, is the recovery authority.

On failure or cancellation, recovery re-reads each alias:

- restore only when it still targets the deployment assigned by this attempt;
- do nothing when it already has the verified prior target;
- never overwrite a target moved by another actor; and
- fail for operator review when ownership or target state is uncertain.

The process installs `SIGINT` and `SIGTERM` handlers before mutation. A signal
stops new work, runs conditional recovery within the reserved budget, flushes a
redacted report, and exits nonzero. The workflow also invokes `recover` in an
`if: always()` step. Every new run reconciles unfinished intents before preflight.
The command never deletes domains, aliases, deployments, or project settings.
After recording an alias intent, it reads the row back and requires an exact
attempt, project, prior-target, requested-target, and candidate match before the
first Vercel mutation.

## Retry And Timeout Policy

- Each Vercel or probe request has a 10-second network deadline.
- Read-only calls retry at most five attempts for resets, timeouts, `408`, `429`,
  and `5xx`.
- A valid `Retry-After` is honored only if it fits the remaining budget; a longer
  delay fails immediately. Missing or malformed values use bounded exponential
  backoff with jitter.
- `400`, `401`, `403`, project `404`, and malformed successful responses do not
  retry. Polling and eventual alias read-back may retry `404` within budget.
- Alias assignment allows at most three mutation attempts. A connection reset,
  timeout, `408`, `409`, `429`, or `5xx` is always followed by read-back: the
  requested target is success, the unchanged baseline may retry, and an unknown
  target is terminal drift. A valid `Retry-After` is honored within both the
  mutation and recovery budgets.
- The workflow records an absolute start time. Both projects share a queue and
  build deadline ending 115 minutes after that start, including dependency
  installation and snapshot work. If setup consumes the budget, preparation
  shortens or fails; it never borrows recovery time. Preparation must stop by
  minute 115, recovery must stop by minute 130, evidence upload retains minutes
  130-135, and the job timeout is 135 minutes.
- Exhaustion always fails closed. Clocks, sleeps, and randomness are injectable
  for deterministic tests.

## Evidence Contract

The command always writes a redacted attempt report and recovery summary. A
successful `prepare` also writes `staging-deployment-manifest.json` with:

- schema version, attempt ID, candidate SHA, registry version, repository, ref,
  and trusted workflow SHA;
- team and project IDs;
- deployment IDs, immutable origins, source SHA, ref, environment, ready time,
  release identity digest, and verification timestamps;
- alias hostnames, prior targets, new targets, and before/after verification
  timestamps;
- production branch, repository-link, branch-scope, and protection results;
- durable alias-intent ID and recovery status; and
- command start/completion times.

No artifact contains tokens, raw identity markers, bypass values, headers,
customer data, provider payloads, or environment values. Snapshot, report,
recovery, and manifest files use temporary-file write, `fsync`, atomic rename,
and parent-directory sync where supported. Partial or malformed files are never
accepted.

Reports and recovery summaries upload with `if: always()`. The success manifest
uploads only after both post-switch API and HTTP checks pass. A later `verify`
produces a new timestamped verification receipt; the original manifest is not
modified.

## Workflow Integration

Update `.github/workflows/staging-release-gate.yml` to:

1. enforce immutable-main workflow identity and check out the workflow SHA with
   persisted Git credentials disabled;
2. keep candidate and project preflight ahead of all mutation;
3. install reviewed backend dependencies;
4. reconcile old intents and run `snapshot`;
5. expose the GitHub token only while performing the existing fast-forward-only
   push;
6. run `prepare` with step-scoped Vercel and control-ledger credentials;
7. run `recover` and upload redacted failure artifacts with `if: always()`;
8. upload the success manifest only on success; and
9. stop with an explicit non-GO message because #139/#140 still block the final
   gate.

Repository-wide concurrency remains `staging-release-gate` with
`cancel-in-progress: false`.

## Observability

Structured events cover project verification, snapshot creation, deployment
discovery/readiness, immutable release verification, alias intent creation,
alias assignment/read-back, recovery start/completion, non-mutating
verification, and failure. Events include attempt ID, phase, project role,
candidate SHA prefix, elapsed milliseconds, retry count, and stable result code.
They omit credentials, headers, full response bodies, and bypass values.

## Test Plan

### Unit tests

- Reject malformed Vercel payloads, wrong repository linkage, unsafe environment
  scoping, wrong protection configuration, production hosts, and missing fields.
- Cover transient retries, `Retry-After`, budgets, nonretryable auth/configuration
  errors, bounded mutation attempts, and mutation read-back.
- Reject old deployment IDs, short/wrong SHA, wrong ref/project, Production
  target, stable alias as immutable identity, and stale readiness.
- Reject release responses with wrong deployment ID, environment, identity hash,
  registry version, SHA, content type, cache behavior, size, or redirect.
- Prove API probes omit the bypass secret and reject both an exposed protected
  route and a Vercel-protected API.
- Cover alias baseline drift, cross-project targets, unassigned aliases,
  production targets, signal cancellation, concurrent movement, and restoration
  failure.
- Prove logs/evidence cannot contain tokens, raw markers, bypass values, headers,
  or raw provider bodies.
- Interrupt atomic evidence writes and reject every partial file.

### Integration tests

Use a local scripted HTTP server plus a fake external ledger to test:

- queued project builds followed by a successful switch;
- no-op branch advancement with no new deployment;
- duplicate matching deployments;
- one failed duplicate while another becomes ready;
- rate limiting and `5xx` recovery;
- timeout after only one project is ready;
- partial alias switching and durable recovery after process restart;
- alias movement by another actor;
- storefront bypass without redirect or leakage;
- public API readiness plus unauthenticated `/orders/me` denial; and
- post-window `verify` rejection for deployment, alias, runtime identity,
  protection, or readiness drift.

Tests never call a real Vercel account.

### Workflow contract tests

Assert immutable-main dispatch, immutable checkout, `persist-credentials: false`,
step-scoped credentials, global non-canceling concurrency, candidate reachability,
pre-push snapshot, fast-forward-only push, no force/`--prod`/Production target,
recovery and failure-artifact `always()` conditions, success-only manifest
upload, pinned actions, and the intentional non-GO stop.

### Credentialed rehearsal

After automated tests pass, an owner runs the workflow against dedicated staging
projects with a merged candidate. The rehearsal proves both newly created
deployments, aliases, runtime identities, API public reachability, Fastify route
protection, storefront bypass behavior, recovery ledger finalization, and
artifact redaction. Missing credentials or unavailable projects means not run,
never pass.

## Reviewable Implementation Slices

The issue remains one PR, with ordered commits:

1. release identity contract plus typed Vercel client, validation, retries, and
   redaction tests;
2. snapshot, deterministic deployment selection, and hardened HTTP probes;
3. durable alias intent, switching, recovery, atomic evidence, and non-mutating
   verification;
4. workflow integration, contract tests, and runbook updates.

The two implementation agents use disjoint write scopes: one owns backend
orchestration and tests; the other owns workflow, repository contract tests, and
documentation. The integrator reviews all cross-scope interfaces before commit.

## Acceptance Criteria Mapping

- Exact candidate: pre-push snapshot, fast-forward-only branch update, and
  full-SHA/ref matching of newly created deployments.
- Project/environment identity: team, repository link, Production Branch,
  branch-scoped variables, Preview target, identity digest, registry version,
  protection, release, readiness, and protected-route checks.
- Stable aliases: strict same-site and production-denylist validation, durable
  intent, assignment, API read-back, HTTP verification, and safe recovery.
- Before/after proof: `snapshot` and post-switch checks plus non-mutating `verify`
  for the post-test and pre-finalization checks in #139/#140.
- Public API with application auth: no Vercel bypass on API probes and an
  unauthenticated protected route must remain denied by Fastify.
- Serialization/fault tolerance: global concurrency, restart reconciliation,
  bounded retries/timeouts, queue-aware polling, and cancellation-safe recovery.
- Fail closed: no success manifest or continuation on uncertain identity,
  readiness, alias, protection, ledger, or recovery state.
- Verification: deterministic unit/integration/workflow tests and an explicitly
  reported credentialed rehearsal.

## Definition Of Done

- Three independent reviewers approve this revised specification before coding.
- Two implementers work on the disjoint scopes above.
- Backend typecheck/tests and repository workflow/validation tests pass.
- Credentialed rehearsal is passed with redacted evidence or explicitly reported
  as not run due to unavailable operator credentials.
- The PR is stacked on the #115 foundation branch, links #138, and does not claim
  to complete #115, #139, or #140.
