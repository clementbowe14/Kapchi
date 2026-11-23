# Issue 115 Staging Purchase-to-Fulfillment Release Gate Specification

Status: Approved by three independent reviewers on 2026-11-23

## Purpose

Issue #115 is the final proof that one reviewed Kapchi release can complete the
customer-to-fulfillment lifecycle in a production-like test environment before
production launch. It coordinates existing feature tests, deployed browser
tests, provider observations, cleanup, and a final `GO` or `NO-GO` record.

The gate does not make production changes. A passing gate is necessary for a
release recommendation, but it is not a substitute for the production launch
runbook in issue #114.

## Current Platform Constraints

This specification is deliberately limited to the repository and hosting plans
currently in use:

- The private repository does not currently provide enforceable protected
  branches or reviewer-protected GitHub environments.
- GitHub artifact attestations are not available for this private repository on
  its current plan.
- Vercel Hobby does not provide a named custom staging environment. Vercel does
  support a persistent Preview branch with branch-specific variables on Hobby.
- Vercel Preview variables can be read during the build and during function
  execution. They must therefore contain test-only, least-privilege values and
  never production credentials.
- The two Vercel projects may build sequentially because Hobby provides limited
  build concurrency.
- No production cron schedule is installed. Gate workflows invoke reviewed
  internal jobs directly and do not wait for cron.
- Vercel Hobby is intended for personal, non-commercial use. It may be used to
  implement and rehearse this gate, but production `GO` requires confirmation
  that Kapchi is on a Vercel plan permitting its commercial use.

Relevant platform references:

- [Vercel deployment environments](https://vercel.com/docs/deployments/environments)
- [Vercel branch-specific Preview variables](https://vercel.com/docs/environment-variables)
- [Vercel automation protection bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
- [GitHub protected branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub artifact attestation availability](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

### Trust level

The current implementation uses a **single-owner procedural trust model**. It
provides reproducible tests, hashes, immutable deployment references, actor and
workflow metadata, and strict validators. It does not claim cryptographic
provenance or make manual production deployment technically impossible.

The owner must:

1. configure both Vercel projects to use a separate `production` branch so
   updates to `main` cannot deploy customer traffic;
2. review and merge the candidate to `main`;
3. dispatch the gate workflow from `main` with that exact merged SHA;
4. allow the workflow to verify preconditions and fast-forward the dedicated
   `staging` branch to the candidate without adding code;
5. after a passing gate, advance `production` to the same source SHA only
   through the issue #114 launch process; and
6. avoid every other production deployment path.

If the repository later receives GitHub Pro or Enterprise capabilities, the
gate should add protected branches, protected environments, and verified
artifact attestations. Those future controls must strengthen this baseline
without changing the scenario contract.

## Environment Model

Add and validate `KAPCHI_ENVIRONMENT` independently of `NODE_ENV`.

| `KAPCHI_ENVIRONMENT` | `NODE_ENV` | Provider requirement | Intended use |
| --- | --- | --- | --- |
| `local` | `development` or `test` | Local/test providers | Developer machine |
| `test` | `test` | Fake or test providers | Automated hermetic tests |
| `staging` | `production` | Test-mode, staging-only providers | Vercel Preview branch |
| `production` | `production` | Live production providers | Customer traffic |

Application startup validates only values available without external provider
calls. Startup must fail when:

- staging uses a live Stripe key, live Clerk issuer, production database,
  a statically denied provider identity, or unrestricted message destination;
- production uses any test provider identity;
- `KAPCHI_ENVIRONMENT` is missing in a deployed environment; or
- the database does not contain the expected environment marker.

Staging keeps production-strength TLS, cookie, CORS, auth, secret-length, and
database-pool rules while requiring test-mode provider identities.

Provider API account identity, Blob store identity, Redis identity, Vercel
project identity, Clerk instance identity, messaging destination, and complete
production-denylist comparisons belong to gate preflight. They are not executed
during a Vercel function cold start.

## Vercel Staging Topology

Both Vercel projects use `production` as the Production Branch. The persistent
`staging` branch therefore deploys only to the built-in Preview environment.
Gate preflight queries both Vercel projects and stops unless the Production
Branch is exactly `production` and neither `main` nor `staging` can deploy
customer traffic. Every staging variable is scoped specifically to the
`staging` branch. General Preview variables must not silently supply
production-like values.

The storefront and API deployments must expose customer-safe release identity
containing only:

- full Git commit SHA;
- Vercel deployment ID;
- `KAPCHI_ENVIRONMENT`; and
- scenario registry version.

Runtime communication uses two stable staging aliases configured before build:
one for the storefront and one for the API. The API uses the stable storefront
origin for CORS, Clerk authorized parties, Stripe return URLs, and customer
links. The storefront uses the stable API origin. This avoids an impossible
cycle in which each immutable deployment URL would need the other before build.

Both aliases must use HTTPS, be distinct hosts, and share one configured
registrable site domain, for example `staging.kapchi.com` and
`api-staging.kapchi.com`. Gate preflight validates the configured site domain
and both hostnames before deployment or fixture creation so the guest-cart
`SameSite=Lax` cookie remains same-site. Credentialed CORS still allows only
the exact storefront origin, not every subdomain of the shared site.

Immutable deployment URLs and deployment IDs remain the identity evidence. Once
both deployments for the candidate SHA are verified, trusted orchestration
assigns or confirms each stable alias against its recorded immutable deployment.
It then verifies:

- both release identities use the same source SHA and registry version;
- browser requests use only the configured stable API alias;
- CORS, Clerk authorized parties, Stripe return URLs, and customer links use
  only the configured stable storefront alias; and
- the Vercel API reports that both aliases target the recorded deployment IDs.

Alias targets are reverified before fixture mutation, after provider evidence,
and immediately before finalization. Any target change is `NO-GO`. Runtime
aliases may carry traffic, but they are never accepted as deployment identity
proof.

The storefront Preview remains protected. Playwright sends
`x-vercel-protection-bypass` and requests the bypass cookie. The staging-only
bypass secret is available to reviewed staging deployment code and the trusted
workflow, but never to production. It is never written to reports, URLs, or
logs.

The API Preview is intentionally public at the Vercel layer so Stripe, Clerk,
and other providers can deliver webhooks without placing a bypass secret in a
URL. Every non-public application route still requires Clerk authorization,
an internal workflow credential, or a verified provider signature. The API uses
exact CORS origins, rate limits public endpoints, and exposes only customer-safe
health and release identity without authentication.

## Candidate and Build Safety

### Secretless candidate suite

Pull requests and candidate commits run without staging or production secrets.
The job provisions ephemeral PostgreSQL and Redis services and runs each suite
once:

```text
backend: npm ci, typecheck, unit tests, database integration tests, fixtures
client: npm ci, lint, unit tests, production build, deterministic Playwright
repository: node --test scripts/*.test.mjs
```

Every required test writes a compact machine-readable result associated with a
stable scenario ID. A skipped required test is `pending`, not `pass`, and blocks
the gate. Reports are retained for seven days and contain no credentials,
addresses, customization text, filenames, provider payloads, or private URLs.

### Reviewed deployment code

Only a SHA already reachable from `main` may be tested by the credentialed
staging workflow. Vercel builds that SHA through the dedicated `staging` branch.
Because Vercel Preview variables are available to build code, every branch
variable is test-only and least privilege. Vercel account-management tokens and
production credentials are never stored in project environment variables.

Before moving `staging`, trusted orchestration verifies through GitHub that the
candidate commit author and verified email resolve to the Vercel Hobby project
owner. The committer is recorded as evidence but is not independently
disqualifying because GitHub may create the merge commit. An unrecognized author
is `NO-GO`, and successful creation of both Vercel deployments remains the
authoritative eligibility check.

The gate records:

- candidate SHA and lockfile digest;
- storefront and API project/deployment IDs;
- immutable deployment URLs;
- Vercel-reported source SHA;
- release-identity responses; and
- hashes of the normalized build and test manifests.

The current plan cannot prove that a later production rebuild is byte-identical
to staging. Records therefore contain separate staging storefront/API deployment
IDs and production storefront/API deployment IDs. Preview deployments containing
staging credentials are never promoted to production. The two deployment sets
must differ while sharing the reviewed source SHA, lockfile digest, and registry
version. The production launch record explicitly states this procedural
limitation.

## Stable Scenario Registry

`deploy/staging-release-scenarios.json` remains the source of the 25 required
scenario IDs:

- cart: guest CRUD, authenticated CRUD, and guest-to-user merge;
- customization: none, short text, long text, text/image, and
  text/image/trim;
- catalog and inventory: fabric, price/priority snapshot, reservation, and
  out-of-stock behavior;
- assets: upload ownership and paid-order admin access;
- checkout: guest success, authenticated success, cancellation/decline, retry,
  and duplicate webhook handling;
- orders: customer-safe lookup, admin queue/transitions, and tracking;
- refunds: full/partial and duplicate/unknown-outcome handling;
- messaging: durable delivery and retry behavior;
- observability: correlation and sensitive-data redaction; and
- fixtures: isolation, ownership, and cleanup.

Each registry entry must contain exact test owners, not prose-only labels. A test
owner is a repository-relative file plus a stable test or report ID. Validation
fails when a required owner is missing, skipped, duplicated, or reports a
different scenario version.

Removing or renaming an ID requires a registry-version change, validator tests,
and an explicit review of the issue #115 acceptance-criteria mapping.

## Gate Lifecycle

The lifecycle is:

```text
candidate-tested -> staging-prepared -> scenarios-executed
-> provider-evidence-recorded -> cleanup-verified -> finalized
```

Any failure, cancellation, timeout, stale record, identity mismatch, missing
scenario, or cleanup error produces `NO-GO`.

### 1. Candidate testing

A secretless workflow runs the deterministic suites and emits one normalized
scenario report. It must be generated from test output; operators cannot type
scenario statuses manually.

### 2. Staging preparation

The owner dispatches the workflow with an exact SHA already reachable from
`main`. A repository-wide `staging-release-gate` concurrency group uses
`cancel-in-progress: false`, so two runs cannot move the branch, aliases,
fixtures, or provider configuration at the same time.

The workflow verifies candidate identity, both Vercel Production Branch
settings, stable alias configuration, and absence of another active attempt.
It then fast-forwards `staging` to the candidate. A non-fast-forward update is
rejected rather than forced. Trusted orchestration waits for both sequential
Hobby deployments and verifies each project ID, deployment ID, source SHA,
immutable URL, release identity, and branch-scoped environment. It assigns the
stable aliases only after both immutable deployments pass verification.

Before mutation, the workflow also verifies dedicated staging identities for:

- PostgreSQL database and environment marker;
- Redis instance;
- Stripe test account with `livemode=false`;
- Clerk test instance;
- Vercel Blob store;
- messaging provider and destination allowlist; and
- storefront and API Vercel projects.

Every identity is compared with a configured production denylist. A match
stops the run before fixtures are created.

### 3. Run-owned fixture preparation

The implementation uses a provider-neutral fixture adapter. The first supported
adapter may target a dedicated staging database; disposable provider branches
are optional until a database provider with a branch API is selected.

The adapter must:

- require the staging environment marker and reject production-like database
  names, hosts, IDs, and markers;
- create an attempt ID and random ownership token;
- create only reviewed scenario fixtures;
- tag or externally ledger every created resource;
- refuse to adopt pre-existing or unowned rows;
- acquire an attempt-scoped advisory lock;
- expire within 24 hours; and
- support idempotent normal and TTL cleanup.

A physically separate staging-gate control database stores the durable resource
ledger and is initialized with `deploy/staging-gate-control.sql`. Its database
identity is available only to trusted GitHub workflows, never to the deployed
Kapchi application. Before any provider call, orchestration writes a
`creation-pending` intent containing the attempt ID, provider, deterministic
namespace, idempotency key, expected account/project, and expiration time. After
the provider returns, the workflow binds the returned handle to that intent
before the resource may be used.

If a call or workflow ends before the handle is bound, reconciliation searches
the exact staging account and deterministic namespace for the unfinished
resource. Cleanup may delete only a bound resource or one discovered from a
matching pending intent after account, project, creation-time, namespace, and
attempt verification. Immutable production IDs are denied even if they appear
in a malformed ledger.

Normal cleanup runs in an unconditional workflow step. A scheduled GitHub
cleanup workflow processes expired completed and pending intents, and every new
gate run performs the same recovery scan before creating resources. Cleaned
ledger entries become immutable tombstones retained for 30 days. Tombstones are
purged only after resource-absence verification and after all provider and final
records have expired.

### 4. Authentication setup

Trusted setup creates ephemeral Clerk customer, non-admin, and admin identities
inside the verified test instance. Browser storage state is written to an
artifact-excluded temporary directory with distinct files per role.

Unconditional teardown revokes every created session, deletes the ephemeral
users, removes local storage-state files, and verifies that no identity belongs
to another Clerk instance or attempt.

### 5. Deployed staging suite

`client/playwright.staging.config.ts` starts no local server and performs no
direct database reset. It runs actual `*.staging.spec.ts` files against the two
immutable deployments.

The deployed suite covers:

- cart CRUD and guest-to-user merge;
- all five customization tiers;
- fabric selection and customer-safe product display;
- image upload and admin artwork authorization;
- guest and authenticated Stripe test checkout;
- confirmation and customer-safe order lookup;
- admin queue, allowed/forbidden transitions, and tracking;
- full and partial refunds through trusted staging API probes; and
- direct invocation of reviewed message, refund, inventory, and maintenance
  jobs where required.

Eventual-consistency reads use bounded polling with jitter. Mutations are never
blindly retried. Playwright tracing, video, and automatic screenshots are
disabled for credentialed staging runs because they can contain cookies,
headers, URLs, and request bodies. Failure diagnostics are converted to compact
structured events, scanned for forbidden keys and deterministic non-sensitive
canaries derived from the attempt ID and candidate SHA, and
uploaded only after the scanner passes.

### 6. Provider observation

Provider APIs are authoritative wherever read-only observation is available.
Separate read-only credentials are used where providers support them. Otherwise,
a dedicated test-account token is restricted to trusted workflow steps and is
never provided to the application runtime or browser; the unavoidable scope is
documented in the final record. Manual evidence is limited to hosted behavior
that cannot be verified through an API, such as the visible Stripe Checkout
success, cancellation, or decline page.

Provider evidence contains only safe object IDs or hashes, result codes,
timestamps, approved hosts, and attempt metadata. It never contains tokens,
cookies, contact details, addresses, customization text, filenames, database
URLs, private Blob URLs, query strings, or raw provider payloads.

### 7. Observability and privacy scan

The logger redaction list must cover credentials, cookies, authorization,
addresses, address lines, customization text, uploaded content metadata, bodies,
and provider payloads. Tests exercise HTTP, webhook, worker, message, refund,
and cleanup events.

The gate captures logs immediately because Hobby log retention is limited. A
sanitized scanner requires correlation identifiers and safe error codes while
failing on forbidden keys or those strict-format canary values. Arbitrary
operator-provided values are never placed in the evidence bundle.

### 8. Cleanup and finalization

Cleanup order prevents traffic from reaching deleted dependencies:

1. stop new gate traffic and verify both stable aliases remain fixed;
2. revoke Clerk sessions and users;
3. remove run-prefixed Blob objects;
4. remove run-owned database and Redis data;
5. verify Stripe and message objects are test-mode, terminal, and excluded from
   workers where providers retain them;
6. verify every ledgered deletable resource is absent; and
7. mark control-ledger entries cleaned and retain their tombstones; and
8. remove local temporary authentication and evidence files.

The finalizer computes the decision from validated records. Operators cannot set
`GO` directly. A `GO` record requires every critical scenario to pass, provider
evidence to be current, and cleanup to be verified.

The cleanup export must include a non-empty expected resource inventory bound
to the attempt ID and candidate SHA. Its provider, attempt-owned namespace,
idempotency-key hash, and staging account/project hashes must exactly match the
exported control-ledger rows. Missing, unexpected, or duplicate rows invalidate
the bundle; cleanup passes only when every expected resource has terminal
absence or approved terminal-isolation evidence.

## Evidence Integrity on the Current Plan

Every record uses canonical JSON and SHA-256 digests. The final record binds:

- repository, workflow file, workflow commit, run ID, attempt, and actor;
- candidate SHA, lockfile digest, and registry version;
- both Vercel project and deployment IDs;
- normalized provider identity hashes;
- candidate, staging, provider, log-scan, and cleanup report digests; and
- creation and expiration timestamps no more than 24 hours apart.

Trusted workflow code downloads referenced GitHub artifacts by run and artifact
ID. The validator consumes that complete local bundle, verifies the recorded
artifact metadata, and recomputes every report and digest. It does not accept
attestation-shaped JSON as proof. Records use
`trustMode: "single-owner-procedural"` and clearly state that GitHub Free
artifacts are not cryptographically attested.

When verified private-repository attestations become available, a new record
version may require `gh attestation verify` against the repository and trusted
workflow identity.

## Production Launch Integration

`validate-launch-record.mjs` must require a final issue #115 record with the
same candidate SHA, lockfile digest, and registry version. The issue #115 record
contains staging deployment IDs. The issue #114 launch record separately
contains production deployment IDs and verifies that they differ from staging
while reporting the same source SHA. The validator rejects `GO` when the gate is
missing, stale, failed, mismatched, manually authored, or has unverified cleanup.

On the current GitHub and Vercel plans this is an enforced repository check but
not an unbypassable platform control. A repository owner can still deploy
manually. The issue #114 runbook must prohibit that path and record the owner who
approved the procedural exception. The contract must not claim that production
promotion is cryptographically impossible without the gate.

Production `GO` also requires recorded confirmation that the active Vercel plan
permits Kapchi's commercial use. Hobby may be used for implementation rehearsal,
but it is not accepted as the commercial production plan.

## Mutation Retry Contract

- Checkout reconciles durable order/provider state and reuses
  `cart-checkout:<orderId>`.
- Refunds reconcile Stripe first and reuse the persisted provider idempotency
  key.
- Blob completion reuses the nonce and exact fingerprints; file bytes are not
  uploaded again automatically.
- Admin and fulfillment mutations reuse their idempotency key and expected
  revision.
- Messaging reuses its persisted delivery idempotency key.
- Unknown outcomes block until durable state is reconciled.
- Transient reads use exponential backoff with jitter, at most three attempts,
  and a 30-second total deadline.
- Authorization, validation, policy, and invariant failures are never retried.

## Implementation Workstreams

After three reviewers approve this specification, two agents work in parallel.

### Agent 1: CI, evidence, and release controls

- implement the environment matrix and safety tests;
- update the scenario registry with exact test owners;
- generate and validate machine-readable scenario reports;
- add the secretless candidate workflow;
- implement evidence, resource-ledger, cleanup, and final-record validation;
- connect the final #115 record to `validate-launch-record.mjs`; and
- update the operator runbook and example records.

### Agent 2: Staging execution and fixtures

- add Vercel bypass support and immutable deployment verification;
- add runtime Clerk setup and unconditional teardown;
- implement the provider-neutral run-owned fixture adapter;
- add actual staging Playwright and trusted API scenarios;
- add bounded polling and direct job invocation;
- add provider observation and privacy-safe log scanning; and
- produce sanitized results compatible with Agent 1's schema.

The agents must use disjoint file ownership where possible and coordinate shared
schemas before editing.

## Operator Inputs Required for a Real Gate Run

Code can prepare and test the workflow, but a real staging run requires the
owner to configure:

- the dedicated `staging` branch in both Vercel projects;
- a separate `production` Production Branch in both projects, so `main` and
  `staging` cannot deploy customer traffic;
- a workflow-only Vercel management token and both project IDs;
- branch-specific Preview variables, a protected storefront bypass secret, and
  an API Preview that is public at the Vercel layer;
- stable staging storefront and API aliases used for CORS, Clerk, Stripe return
  URLs, customer links, and browser/API traffic;
- the configured registrable site domain shared by both HTTPS staging aliases;
- a dedicated staging application PostgreSQL database and environment marker;
- a physically separate workflow-only staging-gate control database;
- a dedicated staging Redis instance;
- Stripe test credentials and webhook endpoint;
- Clerk test-instance credentials;
- a dedicated Vercel Blob store;
- a selected messaging provider and allowlisted test destination;
- production provider identity hashes used only as denylist comparisons; and
- a Vercel plan eligible for commercial use before production `GO`.

Missing operator inputs produce `NO-GO`; they are never silently skipped.

## Acceptance Criteria

- All 25 registered scenarios map to exact automated or provider evidence owners.
- Required tests cannot pass through handwritten scenario status fields.
- Guest and authenticated checkout plus all customization tiers run against the
  exact deployed SHA.
- Both projects use `production` as the Production Branch before `staging`
  moves, and the candidate author maps to the Hobby project owner.
- The workflow alone fast-forwards `staging`, and concurrent gate runs are
  serialized without cancelling an active cleanup.
- Both applications use stable staging runtime aliases whose Vercel targets are
  repeatedly verified against the recorded immutable deployment IDs.
- The two staging aliases are distinct HTTPS hosts under the same configured
  registrable site domain, while credentialed CORS allows only the exact
  storefront origin.
- Application startup rejects invalid environment/key modes and static denylist
  matches; gate preflight rejects matching production provider identities.
- Cart merge preserves quantity, fabric, text, image, trim, price, and production
  metadata.
- Upload, admin artwork, fulfillment, tracking, refund, retry, duplicate, and
  unknown-outcome paths are exercised.
- Authentication state and every deletable run-owned resource are removed.
- Pending resource intents survive cancellation and are reconciled by both the
  scheduled cleanup workflow and the next gate run.
- Provider-retained resources are test-mode, terminal, and isolated.
- Logs contain correlation and safe error codes but no forbidden fields or
  seeded sensitive values.
- The final decision is derived, current, complete, and bound to the reviewed
  SHA, deployments, provider identities, report digests, and cleanup result.
- The production launch validator rejects a missing or mismatched #115 record.
- Staging and production deployment IDs differ while their source SHA, lockfile
  digest, and registry version match.
- Production `GO` requires a hosting plan eligible for commercial use.
- Documentation accurately identifies the current single-owner procedural trust
  limitation.

## Non-Goals

- Testing production customers, payments, credentials, or databases.
- Treating screenshots or provider URLs as cryptographic evidence.
- Claiming GitHub Enterprise attestations or protected environments on the
  current plan.
- Claiming Vercel Hobby provides a custom staging environment.
- Automating arbitrary SQL or deleting provider resources not recorded in the
  attempt ledger.
- Weakening local fixture guards.
- Replacing feature-owned unit and database integration tests.
- Making post-MVP promotions, AI shipping, or catalog-management work a release
  dependency.
