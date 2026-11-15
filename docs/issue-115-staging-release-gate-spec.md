# Issue 115 Staging Purchase-to-Fulfillment Release Gate Specification

Status: Approved by three independent reviewers on 2026-11-14

## Purpose

Issue #115 is the final blocking proof that one reviewed Kapchi release can
complete the customer-to-fulfillment lifecycle in a production-like staging
environment. It coordinates canonical feature tests and records cross-service
evidence; it does not duplicate domain logic or turn production into a test
environment.

A release passes only when secretless candidate tests, trusted staging checks,
and current provider observations all bind to the same full Git SHA and exact
storefront/API deployments. Missing, stale, mixed-release, failed, or
unreconciled evidence produces `NO-GO`.

## Trust and Safety Model

### Candidate trust

- The candidate SHA must be reachable from the protected release branch.
- Candidate-controlled CI scripts and build jobs run only in secretless jobs
  against ephemeral local PostgreSQL and Redis services. Vercel builds must not
  receive runtime secrets.
- Jobs with staging credentials check out trusted orchestration from the
  protected default branch and never execute scripts from an arbitrary candidate
  checkout.
- A reviewed candidate reachable from the protected release branch may run as a
  deployed application with least-privilege staging runtime credentials.
  Production and provider control-plane credentials remain unavailable to it.
- Every job uses minimal GitHub permissions and receives only the provider
  credentials required for that job.

### Staging identity

Add `KAPCHI_ENVIRONMENT=staging` independently of `NODE_ENV=production`.
Staging retains production TLS, CORS, cookie, auth, secret-length, and database
pool rules while requiring test-mode providers. Before any staging mutation,
trusted orchestration attests all of the following against protected expected
values:

- Vercel team, project, deployment ID, immutable deployment URL, alias target,
  and candidate SHA for both storefront and API;
- database provider project/branch identity, database OID, and staging marker;
- Stripe account ID with `livemode=false`;
- Clerk test instance/issuer;
- Vercel Blob store ID and a run-scoped object prefix;
- Redis staging instance identity; and
- messaging provider account plus an exact destination allowlist.

The API exposes its existing customer-safe release identity. The storefront
adds a customer-safe release endpoint containing only SHA, deployment ID, and
environment. Both aliases must resolve to the attested immutable deployments.

### Data and provider isolation

- Live Clerk, Stripe, Blob, Redis, messaging, and database identities are denied
  unconditionally in staging orchestration.
- Synthetic contacts use `example.test`, reserved phone numbers, `DO NOT SHIP -
  TEST` addresses, and non-sensitive artwork bytes.
- Evidence contains result codes, counts, hashes, timestamps, and approved-host
  references only. It never contains tokens, cookies, addresses, customization
  text, filenames, provider payloads, database URLs, or private Blob URLs.
- Provider references must use HTTPS, have an approved host, and contain no
  credentials, query, or fragment. Sanitized captured evidence is a separate
  immutable artifact whose canonical manifest receives a SHA-256 attestation.

## Proof Layers

### Deterministic candidate suite

The secretless candidate job provisions ephemeral PostgreSQL and Redis,
applies migrations, initializes the existing local fixture guard, and transports
its one-time token only through masked job environment. It runs:

```text
backend: npm ci; npm run typecheck; npm test
backend database: RUN_DATABASE_INTEGRATION_TESTS=true npm test
backend fixtures: db:migrate:apply, db:fixtures:init, db:seed:local, db:seed:verify
client: npm ci; npm run lint; npm test; npm run build; npm run test:e2e
repository controls: node --test scripts/*.test.mjs
```

JUnit or equivalent machine-readable reports are aggregated by scenario ID so
capabilities remain separately visible without rerunning whole suites. New
Playwright tests cover only browser/cross-service seams; canonical domain
invariants remain in Vitest and database-integration tests.

### Deployed staging suite

Create `client/playwright.staging.config.ts`. It starts no local server and
performs no direct database reset. It accepts exact protected HTTPS origins,
uses guest, customer, non-admin, and admin projects, creates authentication state
at runtime, and removes that state during teardown. Eventual-consistency reads
use bounded polling; mutations are never blindly retried.

The suite uses a trusted, API-based run fixture contract described below. It
proves successful guest and authenticated checkout, each customization tier,
cart merge, confirmation/lookup, admin queue and artwork access, fulfillment,
and customer-visible tracking against the exact deployed candidate.

### Provider observation

Manual evidence is limited to external state that hermetic automation cannot
authoritatively observe: Stripe-hosted success/cancel/decline screens and object
visibility, Stripe refund visibility, Vercel Blob object visibility, delivery to
allowlisted inboxes/numbers, and provider/Vercel log correlation. Kapchi-side
authorization, idempotency, retry, reconciliation, and redaction assertions
remain automated.

Transient timeouts, retry exhaustion, duplicate webhook delivery, and unknown
provider outcomes are induced through deterministic adapters and signed webhook
replays, not unreliable attempts to break hosted Stripe Checkout.

## Stable Scenario Registry

The versioned machine-readable registry is the source of valid IDs. Each entry
names its proof mode, canonical test owner, fixtures, and required assertions.

| ID | Required proof | Canonical owner and assertions |
| --- | --- | --- |
| `CART-GUEST-CRUD` | CI + staging | Cart service/Playwright: guest add, quantity update, remove, duplicate submit |
| `CART-AUTH-CRUD` | CI + staging | Cart service/Playwright: authenticated add, update, remove |
| `CART-CLAIM-MERGE` | CI + staging | Claim integration: preserve quantity, fabric, text, image asset ID, trim, price and production metadata |
| `CUSTOM-NONE` | CI + staging | Checkout/order snapshot contains no paid customization fields |
| `CUSTOM-SHORT-TEXT` | CI + staging | Short-text limits, price, snapshot, and prohibited image/trim fields |
| `CUSTOM-LONG-TEXT` | CI + staging | Long-text limits, price, snapshot, and prohibited image/trim fields |
| `CUSTOM-TEXT-IMAGE` | CI + staging | Text/image entitlement, asset binding, price and order snapshot; trim denied |
| `CUSTOM-TEXT-IMAGE-TRIM` | CI + staging | Text/image/trim entitlement, trim size, price and order snapshot |
| `CATALOG-FABRIC` | CI + staging | Selected fabric/image and immutable fabric snapshot; customer output hides SKU/IDs |
| `CATALOG-PRICE-PRIORITY` | CI | Immutable minor-unit/currency price and production-priority snapshots |
| `INVENTORY-RESERVATION` | CI | Reserve, convert, release, expiry, concurrent contention and out-of-stock denial |
| `ASSET-UPLOAD-OWNERSHIP` | CI + staging + provider | Authorized intent/token, Blob completion, correct cart-item attachment, checkout preservation, and admin retrieval succeed; wrong customer cannot create an intent/token for another cart; callback signature, timestamp, nonce, path and fingerprints are exact; altered/replayed completion fails |
| `ASSET-ADMIN-ACCESS` | CI + staging | Anonymous/non-admin denied; admin allowed only for paid, attached, private, bound, non-quarantined artwork; deleted/mismatched/unselected denied |
| `CHECKOUT-GUEST-SUCCESS` | CI + staging + provider | Guest order, Stripe test session, confirmation and public order number |
| `CHECKOUT-AUTH-SUCCESS` | CI + staging + provider | Authenticated ownership, order, Stripe test session and confirmation |
| `CHECKOUT-CANCEL-DECLINE` | CI + staging + provider | Cancellation preserves recoverable cart; declined payment creates no paid order |
| `CHECKOUT-RETRY-DUPLICATE` | CI | Reconcile unknown state; reuse `cart-checkout:<orderId>`; duplicate signed webhook is harmless |
| `ORDER-CUSTOMER-LOOKUP` | CI + staging | Public-number/contact lookup is customer-safe and exposes no catalog/provider IDs |
| `ADMIN-QUEUE-TRANSITIONS` | CI + staging | Queue visibility; allowed and forbidden transitions; idempotency key + expected revision |
| `FULFILLMENT-TRACKING` | CI + staging | Carrier/tracking mutation becomes customer-visible with no private operational fields |
| `REFUND-FULL-PARTIAL` | CI + staging + provider | Full/partial minor-unit refunds, persisted provider key, Stripe reconciliation before retry |
| `REFUND-DUPLICATE-RETRY` | CI | Duplicate effect/replay is idempotent; unknown outcome blocks until reconciled |
| `MESSAGE-DELIVERY` | CI + provider | Persisted delivery key, retry/duplicate behavior, allowlisted external receipt |
| `OBS-CORRELATION-REDACTION` | CI + staging + provider | Correlation and safe error codes across HTTP/webhook/worker/delivery; forbidden sensitive fields absent |
| `FIXTURE-ISOLATION-CLEANUP` | CI + staging | Identity attestation, run ownership, provider cleanup, TTL cleanup, no unowned mutation |

Every GitHub issue #115 criterion maps to at least one ID above. Removing or
renaming an ID requires a registry-version change and validator/test update.

## Remote Staging Fixture Contract

The local `parseSafeFixtureTarget` behavior remains unchanged. Shared staging
databases are never initialized with `kapchi_fixture`.

Each gate attempt instead uses a disposable database branch/database created by
trusted orchestration. The required order is: create and attest the database;
deploy the reviewed API with its restricted URL and staging runtime credentials;
deploy the storefront against that immutable API; assign temporary run aliases;
attest both aliases, deployments, and release identities; run the gate; capture
provider evidence; restore/remove aliases; verify final database invariants;
delete the remaining deletable provider resources; delete the disposable
database; verify resource absence and retained-provider terminal isolation; then
finalize. This ordering prevents traffic from reaching an API after its database
has been deleted. Trusted orchestration invokes Vercel's deployment control plane
without running candidate scripts in the credentialed job.
Before use, a separate staging runner requires:

1. exact provider project and branch IDs from protected configuration;
2. a restricted role that can access only the disposable database;
3. provider-confirmed creation time and an out-of-band marker bound to the
   database OID, attempt ID, candidate SHA, and random token hash;
4. an unconditional mismatch check against every production/staging-shared
   account, project, branch, database OID, and provider identity;
5. `(run_id, fixture_key)` ownership, a run advisory lock, and refusal to adopt
   any unowned row; and
6. automatic expiry no later than 24 hours.

The runner accepts only GitHub OIDC workload identity with exact audience,
repository, protected environment, workflow identity, attempt ID, candidate SHA,
deployment IDs, short expiry, and one-time replay protection. Candidate and
browser code never receive runner credentials. Every call is audited,
rate-limited, schema-restricted, bound to one attempt, and may provision only
reviewed scenario fixtures; arbitrary SQL and caller-provided table names are
forbidden.

Cleanup is idempotent. Deletable resources (temporary aliases, disposable
database, run-prefixed Blob objects, ephemeral Clerk users/sessions) must be
absent afterward. Provider-retained resources (completed Stripe sessions,
PaymentIntents, refunds, messages, and provider logs) must carry the attempt ID,
be test-mode, terminal/non-reusable, and excluded from workers. Cleanup verifies
deletion only where supported and terminal isolation everywhere else. Any
cleanup or verification failure blocks release and triggers the 24-hour TTL
fallback plus alerting.

## Mutation Retry Contract

- Checkout reconciles durable order/provider state and reuses
  `cart-checkout:<orderId>`.
- Refunds reconcile Stripe first and reuse the persisted provider idempotency
  key.
- Blob completion reuses the nonce and exact business/completion fingerprints;
  file uploads are not repeated automatically.
- Admin/fulfillment mutations reuse their idempotency key and expected revision.
- Messaging reuses its persisted delivery idempotency key.
- Unknown outcomes always block until durable state is reconciled.
- Transient reads use exponential backoff with jitter, at most three attempts,
  and a 30-second total deadline. Authorization, validation, policy, and
  invariant failures are never retried. Mutation retry limits are the existing
  domain-specific persisted limits and may not exceed three provider dispatches
  per gate attempt. Exhaustion is terminal `NO-GO`; an unknown mutation outcome
  receives no new write until reconciliation proves whether it occurred.

## Evidence Lifecycle

The attempt state machine is `prepared -> awaiting-provider-evidence ->
evidence-recorded -> cleanup-verified -> finalized`. Cancellation, failure, and
expiry invoke idempotent cleanup; TTL cleanup is a fallback, not the normal path.

### Prepare

A protected manual workflow accepts a candidate SHA only after proving it is
reachable from the protected release branch. Secretless jobs test candidate
code. Trusted default-branch orchestration then attests/deploys/probes staging
and emits an immutable, GitHub-attested draft artifact containing:

- attempt ID, workflow run ID, registry version, candidate SHA;
- storefront/API Vercel team, project, deployment, alias, and immutable URLs;
- environment/provider identity hashes;
- generated automated scenario results; and
- safe provider object IDs or hashes plus attempt metadata needed to bind later
  observations to objects created by this exact run.

After canonical serialization, the workflow hashes the completed manifest and
places its SHA-256 digest in a separate GitHub attestation and workflow output;
the manifest never contains its own digest. The artifact is retained for 30
days. Reruns create a new attempt ID and never replace prior attempts.

### Record provider evidence

An environment-protected workflow restricted to authorized staging reviewers
accepts an attempt ID plus sanitized provider references. It retrieves the
attested prepare artifact, verifies its digest/provenance, enforces a 24-hour
freshness limit, and verifies each provider object reference against the safe
object ID/hash or attempt metadata emitted during prepare. Provider references
identify external objects but are not treated as immutable artifacts. Sanitized
captured evidence is stored as a GitHub artifact; its canonical manifest receives
a separate SHA-256 attestation. GitHub supplies the authenticated actor and
environment approval audit trail; typed owner names are not trusted. Provider
evidence is captured before cleanup.

### Finalize

Trusted default-branch code retrieves both immutable artifacts by workflow run
and artifact ID, verifies attestations, digests, SHA/deployments, registry
version, actors, freshness, and complete scenario coverage, and generates the
final decision only after cleanup is verified. Operators cannot set `GO`
directly. Any failed, pending, stale, missing, mixed, or cleanup-failed critical
result yields `NO-GO`.

The final manifest is retained as a GitHub artifact and receives provenance
attestation. It is the issue #115 staging-gate artifact referenced by the
existing issue #114 launch record `smoke` evidence. `validate-launch-record`
must verify that reference/digest and require a matching, passing issue #115
manifest before production `GO`; this specification does not create a competing
launch record.

## Deliverables

1. Approved specification and versioned scenario registry.
2. Strict prepare/manual/final manifest validators and edge-case tests.
3. Protected prepare, evidence-recording, and finalize workflows.
4. Storefront release identity endpoint and staging Playwright configuration.
5. Separate disposable remote-fixture runner with identity and cleanup tests.
6. Missing canonical integration/Playwright coverage identified by the registry.
7. Operator runbook and sanitized example artifacts that do not claim a real
   staging run.
8. Launch-record integration requiring a matching passing gate for `smoke`.

## Acceptance Criteria

- All registered scenarios report independently and map every issue criterion.
- Guest and authenticated successful checkout plus every customization tier are
  proven against the deployed candidate.
- Candidate-controlled CI/build jobs never receive protected credentials; only
  reviewed deployed code receives least-privilege staging runtime values, while
  trusted orchestration alone receives provider management credentials.
- Both deployments and all provider identities are attested before mutation.
- Local fixture protections remain unchanged; remote fixtures are disposable,
  run-owned, bounded, and verified clean.
- Provider observation covers external state only; authorization, retry,
  idempotency, reconciliation, and redaction remain automated.
- Final decisions are workflow-generated, immutable, current, complete, and
  bound to SHA, deployments, environment identities, actors, and artifact
  digests.
- Production `GO` is impossible without a matching passing #115 artifact.

## Non-Goals

- Testing production customers, payments, credentials, or databases.
- Automating Stripe or Vercel Dashboard UI interactions.
- Weakening local fixture guards or initializing a shared staging database.
- Replacing dependency-owned feature tests.
- Making post-MVP promotion, AI shipping, or catalog-management work a release
  dependency.
