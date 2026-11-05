# Issue 114: Production Launch Runbook and Release Controls

Status: Approved by three independent reviewers on 2026-11-05 (Revision 11)

## Objective

Create one executable, evidence-based release workflow for Kapchi's production
storefront and API. The workflow must deploy the Next.js client to Vercel and the
Fastify backend as a separate DigitalOcean App Platform service, serialize
forward-only PostgreSQL migrations before backend traffic is enabled, verify
production dependencies and routing, define monitoring and recovery, and block a
go decision until named owners attach timestamped evidence.

This issue delivers repository controls, deployment templates, verification
commands, and runbooks. It does not invent production URLs, provider resource
IDs, backup results, alert destinations, or approval evidence. Those values are
operator inputs recorded at launch time.

## Current Findings

- The root Docker image starts Next.js and Fastify in one container, while the
  accepted production topology is a Vercel client plus a separately deployed
  backend.
- Fastify currently reflects every CORS origin while allowing credentials.
- Clerk tokens verify the issuer but not an intended audience.
- `/health` is a dependency-free liveness response. `/ready` checks PostgreSQL
  only; it does not check Redis or schema currency and throws an unstructured 500
  when a dependency is unavailable.
- The migration CLI uses `DATABASE_URL`, has no cross-process lock, and can race
  if two deployment jobs start together. Individual migration files are already
  transactional and forward-only.
- Database reset and local seed commands already contain local/non-production
  guards. These controls need explicit production regression tests.
- Request, checkout, cart, Stripe webhook, messaging, refund, database, and Redis
  failures already emit redacted structured logs, but there is no single
  production alert contract or launch evidence record.

## Production Topology

| Component | Owner | Public address | Responsibility |
| --- | --- | --- | --- |
| Next.js client | Vercel project | `PRODUCTION_CLIENT_URL` | Browser UI, server rendering, `/api/blob/upload` token exchange |
| Fastify backend | DigitalOcean App Platform service | `PRODUCTION_API_URL` | Public API, auth enforcement, asset metadata, payments, webhooks, admin workflows |
| PostgreSQL | DigitalOcean Managed PostgreSQL | private/provider endpoint only | Durable commerce and operational state |
| Redis/Valkey | Managed Redis-compatible service | private/provider endpoint only | Guest/session cache and coordination |
| Vercel Blob | Vercel Blob store | never exposed as an application origin | Public catalog media and private customer artwork |
| Clerk | Clerk production instance | provider-hosted | Authentication, JWT/JWKS, user roles |
| Stripe | Stripe live account | provider-hosted | Checkout, payment, refund, webhook delivery |
| Messaging gateway | Configured email/SMS provider | provider-hosted | Transactional and admin-authored delivery |

The launch requires same-site custom domains, for example
`https://shop.<kapchi-domain>` and `https://api.<kapchi-domain>`. The browser uses
the API domain directly through `NEXT_PUBLIC_API_BASE_URL`; Vercel server-side
code uses the same public HTTPS API through `BACKEND_INTERNAL_URL`. This preserves
the existing `SameSite=Lax` guest-cart cookie across same-site requests while
CORS still enforces the exact storefront origin. Deploying on unrelated
`*.vercel.app` and `*.ondigitalocean.app` browser origins is preview-only and is
not a production launch topology. A real-browser release test must add a guest
item, reload, claim the cart after sign-in, and prove the cookie/cart survives.

Every browser call to Fastify, including cart summary, uses the shared direct API
URL builder. The generic Next.js `/api/*` proxy is removed. The sole relative
`/api` call is `/api/blob/upload`, which is owned and handled by Next.js; that
route calls Fastify server-to-server through `BACKEND_INTERNAL_URL`.

The backend allowlists only the exact client origin and validates that origin on
every credentialed state-changing request. Requests without `Origin` are allowed
only for authenticated server-to-server routes and explicitly public safe-method
routes; browser mutation routes reject a missing or unauthorized origin before
business logic. The Blob callback secret is shared only by the Vercel and
Fastify runtimes.

The existing combined root Dockerfile remains available for local/single-service
testing but is not the production launch artifact. Add a backend-only production
Dockerfile and a checked-in DigitalOcean App Platform template with no secret
values.

## Environment Ownership and Secret Inventory

Add `docs/runbooks/production-environment.md` with a table containing variable
name, platform, build/run scope, secret/config classification, required/optional
state, rotation owner, and validation behavior. No document or template contains
a real value.

### Vercel client

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (build/runtime config)
- `NEXT_PUBLIC_API_BASE_URL` (build/runtime config, exact API HTTPS origin)
- `BACKEND_INTERNAL_URL` (runtime config, exact API HTTPS origin)
- `CLERK_SECRET_KEY` (runtime secret)
- `BLOB_READ_WRITE_TOKEN` or Vercel workload identity values used by the chosen
  Blob SDK path (runtime secret)
- `ASSET_UPLOAD_CALLBACK_SECRET_CURRENT` (runtime secret, same value on backend)
- `ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT` (non-secret stable rotation identifier)
- `ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS` and
  `ASSET_UPLOAD_CALLBACK_KEY_ID_PREVIOUS` plus
  `ASSET_UPLOAD_CALLBACK_SECRET_PREVIOUS_EXPIRES_AT` (optional rotation overlap)

### Fastify service and deployment jobs

- Clerk: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER`,
  `CLERK_JWKS_URL`, `CLERK_JWT_AUDIENCE`, `CLERK_AUTHORIZED_PARTIES`,
  `CLERK_WEBHOOK_SECRET`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`,
  `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL`
- PostgreSQL: `DATABASE_URL`, `DATABASE_DIRECT_URL`, pool/timeout/SSL/budget
  variables
- Redis: `REDIS_URL`
- Blob/assets: DigitalOcean Fastify requires `BLOB_READ_WRITE_TOKEN`; Vercel code
  may use its workload-injected `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID` or its
  own `BLOB_READ_WRITE_TOKEN`. Callback rotation uses the current/previous/expiry
  variables above. Bounded private-read/upload settings remain backend-owned.
- Messaging: `MESSAGE_DELIVERY_URL`, `MESSAGE_DELIVERY_TOKEN`,
  `MESSAGE_WEBHOOK_SECRET`, `MESSAGE_FROM_EMAIL`, `MESSAGE_FROM_SMS`
- Routing/operation: `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`,
  `CORS_ALLOWED_ORIGINS`, `ORDER_LOOKUP_BASE_URL`, `RELEASE_SHA`,
  `RELEASE_IMAGE_DIGEST`, `MESSAGE_CANARY_DESTINATION`

Production validation requires `CLERK_JWT_AUDIENCE`, exactly one HTTPS client
origin in `CORS_ALLOWED_ORIGINS`, `DATABASE_DIRECT_URL`, and a complete private
Blob credential strategy. Messaging variables are all-or-none: a configured
gateway requires its token, webhook secret, and at least one sender. The
environment validator reports variable names and bounded reasons only, never
values.

Production additionally rejects Stripe or Clerk test/placeholder key prefixes,
HTTP provider URLs, `DATABASE_SSL_MODE=disable|no-verify`, Redis without TLS,
shared callback/webhook secrets below 32 bytes, and simultaneous token and OIDC
Blob strategies on Vercel. Vercel OIDC requires both `VERCEL_OIDC_TOKEN` and
`BLOB_STORE_ID`; DigitalOcean always requires `BLOB_READ_WRITE_TOKEN`. A release preflight calls bounded provider
identity endpoints to prove the Clerk publishable/server credentials resolve to
the configured issuer and the Stripe key resolves to the recorded live account;
it records only account/instance fingerprints, never keys.

## Runtime Security and Readiness

### CORS and Clerk

- Add `CORS_ALLOWED_ORIGINS` as a comma-separated exact-origin allowlist.
- Production rejects missing, non-HTTPS, wildcard, path-bearing, query-bearing,
  credential-bearing, duplicate, or malformed origins during startup.
- Development defaults to local client origins. Requests without an `Origin`
  remain valid for server-to-server and health traffic. Disallowed browser
  origins receive no CORS grant.
- Add `CLERK_JWT_AUDIENCE`; production requires it. `jwtVerify` validates issuer
  and audience. It is the exact API resource identifier, not the storefront URL.
  A multi-audience claim passes only when this exact identifier is a member.
- Add `CLERK_AUTHORIZED_PARTIES` containing the exact storefront origin. The JWT
  `azp` claim must match one configured party. Audience and authorized party are
  independently validated. Tests cover valid/missing/wrong audience, valid and
  invalid `azp`, issuer drift, and multi-audience claims.
- Credentialed mutation routes apply the same exact-origin check independently of
  CORS response headers, preventing a non-browser or malformed preflight path from
  bypassing CSRF protection.
- Stripe, Blob, Clerk, and messaging webhook/callback POST routes are explicit
  server-to-server exceptions to browser-origin checks. Each verifies its
  provider signature or callback HMAC, freshness, and replay state before parsing
  or invoking business logic; absent or invalid authentication fails closed.

### Health endpoints

- `GET /health` remains a dependency-free liveness check and returns 200 with a
  stable, non-sensitive contract.
- `GET /ready` checks PostgreSQL queryability, Redis `PING`, applied migration
  currency, and private Blob credential configuration. It never performs a
  billable/provider Blob read on each probe.
- A fully ready response is 200 and lists bounded dependency states. Any required
  dependency failure returns 503 with `status: "unready"`, a stable dependency
  code, and no provider/database error message.
- Readiness emits a deduplicatable structured event with failed dependency names.
  Liveness must not fail merely because a dependency is down.
- Each database/Redis/schema check has a 500 ms deadline and the overall probe has
  a 1.5 second deadline, below the platform's 3 second health-check timeout.
  Concurrent probes share one in-flight promise and a result is cached for at
  most 2 seconds. Timeouts return 503 and never accumulate unbounded work.
- DigitalOcean routes readiness to `/ready` to prevent traffic and liveness to
  `/health` to restart a wedged process. External verification calls the public
  HTTPS URLs, not container-local endpoints.

Private Blob *configuration* is a readiness condition. Actual private Blob
authorization is verified once per release with a designated non-customer
canary object or a newly uploaded-and-deleted canary through the supported API;
its URL/token/content is never written to the launch record.

PostgreSQL and Redis currently connect before Fastify starts. Initial dependency
failure therefore remains fail-fast: the process never listens, and the platform
sees failed startup/liveness. Once startup succeeds, `/health` remains available
during a later dependency outage while `/ready` removes the instance from
traffic. Tests cover both startup failure and post-start readiness failure.

The Blob callback uses key-ID-directed, constant-time comparison plus a signed timestamp
and nonce with a five-minute acceptance window. Nonces are durably one-use, and
rotation accepts `CURRENT` and an unexpired `PREVIOUS` for at most 24 hours. New
callbacks use only the current key ID. Removing `PREVIOUS` is blocked until the
overlap expires and callback logs show no old-key use for one hour. The
callback validates the configured Blob store identity, HTTPS hostname, expected
key prefix, content type, and declared size before persisting metadata.

Key IDs are operator-generated stable opaque identifiers matching
`^[A-Za-z0-9_-]{8,64}$`; they are not derived from secret bytes and cannot be
reassigned to a different secret. Nonce consumption and asset finalization occur
in one database transaction. An identical completion retry after commit returns
the original success without rewriting metadata; the same nonce with different
canonical business fields fails as replay/tampering.

The upload-intent response creates the callback nonce and signed request
fingerprint; provider retries must reuse that nonce rather than minting one. The
callback looks up committed nonce/fingerprint state before applying timestamp
freshness. A matching committed retry returns its stored result for seven days
even after the five-minute first-delivery window; a mismatched reuse fails. An
unseen nonce must be inside the five-minute window, and a new nonce for an
existing upload intent is rejected. Nonce/result retention and expiry are handled
by the worker only after the seven-day retry window.

The canonical request fingerprint binds the nonce and every business field but
excludes the authentication envelope (`keyId`, timestamp, and signature). A
delayed provider retry invokes the current Vercel callback code, which re-signs
the same nonce/fingerprint with the current key and a fresh timestamp. Fastify
requires a currently valid current/overlap key even for committed retries, then
matches the canonical fingerprint and returns the stored result. An envelope
signed only by an expired previous key is rejected; retired secrets are not kept
for seven days. Tests cover current-key re-signing after rotation and rejection of
old-key, altered-business-field, and new-nonce retries.

## Migration Contract

Refactor the migration command into import-safe, tested functions and add the
following rules:

1. Migration jobs use `DATABASE_DIRECT_URL`, falling back to `DATABASE_URL` only
   outside production. Production fails if the direct URL is absent.
2. `apply` uses one dedicated connection and acquires one PostgreSQL advisory lock
   for the full migration run. `lock_timeout` bounds acquisition to 60 seconds.
   Concurrent jobs wait only within that bound, then reread history and apply each
   migration at most once. Timeout failure is sanitized and non-retry-looping.
3. Duplicate migration IDs, an applied ID/name mismatch, or a content-checksum
   mismatch fails before any new migration runs. `schema_migrations` gains a
   SHA-256 content checksum. New rows always include it.
4. Every migration stays in its own transaction. A failed file rolls back, leaves
   later files pending, exits nonzero, and is safe to retry after the defect is
   corrected.
5. Existing checksum-null ledger rows require a one-time
   `db:migrate:baseline-checksums -- --confirm-database <exact-name>` operation.
   It first proves the ledger IDs/names exactly match the release, records a
   schema-only dump hash and owner evidence, and then fills only null checksums.
   It never overwrites a non-null checksum. Production `apply` and `check` refuse
   to proceed while any checksum is null.
6. Add `db:migrate:check`, a read-only command that exits nonzero for pending,
   missing, duplicate, or drifted migration records.
7. The DigitalOcean `PRE_DEPLOY` job runs `db:migrate:apply` and then
   `db:migrate:check`. A failed job prevents the new service deployment from
   receiving traffic. Runtime `/ready` also fails if the schema is not current.
8. Migration errors expose only stable error codes, migration IDs, and run IDs;
   raw PostgreSQL errors and connection coordinates are never printed.

The pre-deploy job and API service build from the same immutable Git SHA and
backend image digest. `RELEASE_SHA` and `RELEASE_IMAGE_DIGEST` are required in
production and included in bounded `/health` and `/ready` responses. Verification
fails if migration evidence, backend responses, and the intended release do not
match.

Production migrations follow expand/contract compatibility: release N adds
nullable/additive schema and code that tolerates old/new states; destructive
cleanup occurs only in a later release after observation. Database rollback is
roll-forward by default. Restoring a database is a disaster-recovery operation,
not a routine application rollback.

## Deployment Artifacts

Add:

- `backend/Dockerfile` for the Fastify production image, running as a non-root
  user and exposing only the backend port;
- `deploy/digitalocean.backend.template.yaml` containing the backend service,
  a single-instance background worker, pre-deploy migration job,
  readiness/liveness probes, termination grace period, App-Spec-supported alerts,
  and secret-name placeholders only;
- `scripts/verify-production.mjs` for bounded external HTTPS, health, readiness,
  CORS, and route checks;
- backend scripts for production dependency/schema preflight and operational
  queue health;
- `docs/runbooks/production-launch.md`, the single ordered operator procedure;
- `docs/runbooks/templates/launch-record.md`, the immutable-per-release evidence
  form;
- `docs/runbooks/production-backup-restore.md` and a guarded non-production
  restore-drill command.

The deployment template is reviewed source of truth but requires operator-filled
resource IDs/domains and encrypted platform values. Applying it is an explicit
operator action, never a CI side effect from a pull request.

Add an import-safe `worker` entry point in the same immutable backend image. One
initial worker instance coordinates existing lease/idempotency-safe operations:
message and transactional-notification dispatch every 10 seconds, Stripe/refund
reconciliation every 30 seconds, inventory expiration reconciliation every 60
seconds, and shipping-export PII purge every 15 minutes. Each iteration has a
bounded timeout, structured start/success/failure events, and graceful SIGTERM;
one failed operation does not suppress later operation types. The operational
health command detects exhausted work but does not replace these processors.
Worker cadence, singleton scaling for launch, and later horizontal-scaling
criteria are documented and tested with fake clocks.

Automatic production promotion is disabled on both platforms. Release order is:

1. build client and backend from one immutable Git SHA; record Vercel deployment
   ID, backend image digest, and worker image digest;
2. deploy the Vercel build as an unpromoted/staged deployment;
3. run checksum/migration preflight and the DigitalOcean pre-deploy migration job;
4. deploy backend and worker, wait for public `/ready`, and run API/provider
   canaries against the new backend;
5. promote the staged Vercel deployment, then run the same-site guest-cart and
   full smoke workflow;
6. observe for the defined window and sign `GO` or roll back.

Rollback removes/promotes the client first so it no longer sends the new contract,
then rolls the API and worker back only after an explicit N/N-1 schema and API
compatibility check. If compatibility is false, freeze writes and roll forward.

## Backup, Restore, Rollback, and Roll-Forward

For DigitalOcean Managed PostgreSQL, document the provider's automatic daily
backup and seven-day retention contract, plus an owner-controlled encrypted
logical backup before launch and before a high-risk migration. The launch owner
must confirm the purchased plan and current provider policy instead of assuming
the template guarantees retention.

The guarded restore drill:

1. accepts source and disposable target database URLs through environment only;
2. derives database name, OID/system identifier, server address, and a dedicated
   `kapchi_restore_guard.target` marker from each live connection. The marker is
   the only object allowed by the target emptiness check and is stored in a schema
   excluded from the dump/restore operation. The tool rejects equal
   server identities even through URL aliases, every configured normal/staging/
   production identity, a target without the marker, and a nonempty target;
3. requires a least-privilege target credential, the exact target database name,
   and an out-of-band disposable-target allowlist entry. Credentials are passed
   through environment/descriptor files, never command arguments or output;
4. requires the same PostgreSQL major-version client as the source. `pg_dump`
   custom-format output streams directly through age encryption to restricted
   temporary storage; no plaintext dump is written. The drill verifies the
   encrypted artifact SHA-256 before decrypting through a pipe into
   `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`;
5. runs migration check, bounded integrity counts, and post-restore reconciliation
   reports for Stripe webhook inbox, refunds/manual review, messages,
   notifications, reservations, and shipping-export retention. No provider call
   or worker mutation runs against the restored copy;
6. emits a sanitized JSON/Markdown evidence summary containing timestamp,
   commit SHA, migration state, duration, row-count categories, and pass/fail,
   but no URLs, users, hosts, or customer data;
7. never drops a database automatically. The operator separately destroys the
   confirmed disposable target, records provider destruction evidence, and
   removes the encrypted drill artifact according to the drill retention rule.

Commit one recorded drill against synthetic/non-production data. The production
launch record must link a managed-provider restore-to-new-cluster drill completed
within 30 days of launch; a local drill proves tooling but does not substitute for
that provider drill.

The encrypted pre-launch logical backup is stored in a separately permissioned
object store for 30 days, with an age recipient key owned by the database recovery
owner and a second recovery approver. Access and deletion are evidenced. Managed
daily backups retain the provider's current seven-day window; the release owner
re-verifies that policy and plan at launch. Backup destruction never precedes the
end of the rollback/observation window.

Application rollback promotes the previous known-good Vercel deployment and
DigitalOcean deployment only when the current database is backward compatible.
If the migration is incompatible, stop traffic and roll forward with a repair.
The runbook defines decision owners, data-write freeze conditions, webhook/job
handling during rollback, and post-recovery reconciliation.

## Monitoring and Alert Contract

Add a machine-readable alert inventory and a validator. Every alert has a stable
ID, owner, severity, signal/query, threshold/window, notification destination
class, runbook section, and evidence link placeholder.

Required alerts:

| Signal | Initial threshold | Response |
| --- | --- | --- |
| Backend 5xx | >= 5 responses or >= 2% for 5 minutes | page launch/on-call owner; correlate request IDs |
| Public readiness | 2 consecutive failures from two regions | stop rollout, inspect dependency state |
| PostgreSQL | readiness failure or connection saturation >= 80% for 5 minutes | halt deploy/background work |
| Redis | readiness failure or connection error for 2 minutes | inspect managed service; protect guest/cart flows |
| Stripe webhook | any `stripe.webhook.failed`; exhausted inbox count > 0 | reconcile event IDs in Stripe and inbox |
| Background jobs | exhausted/terminal-failed retry count > 0 | inspect bounded job IDs/codes and provider status |
| Deployment/migration job | any failure | block go decision |

App-Spec-supported resource alerts are declared in the template. DigitalOcean
deployment, domain, scaling, and failed-job alerts that are configured only
through its Alerts UI/API are explicit operator steps with exported/screenshot
evidence; the template does not claim to configure unsupported rules.

PostgreSQL connection saturation is sourced from the DigitalOcean Managed
Database `current connections` metric, divided by the provider plan's recorded
connection limit. The database owner configures an 80%/five-minute provider
alert and records the plan limit, alert export, and a provider test-notification.
Application logs and operational-health output are not used to estimate this
ratio. The runbook reconciles the provider limit with
`DATABASE_MAX_CONNECTIONS`, reserved connections, instance count, and pool max.

Better Stack is the launch external uptime/log-alert platform. The production
runbook creates API `/health` and `/ready` monitors in at least US and EU regions,
with TLS verification and two consecutive failures before escalation, and a
storefront monitor. Redacted Fastify JSON logs are forwarded to a Better Stack
source. Checked-in query definitions cover 5xx percentage/count,
`stripe.webhook.failed`, Redis/database errors, and operational-health job
failures. Notification policy uses the named incident owner and one secondary
channel. Repository tooling can create/verify monitor metadata when supplied a
runtime API token, but never stores that token or provider IDs in source.

Every alert evidence record includes the provider URL/ID, current exported
configuration with secret fields removed, a timestamped safe test signal, the
received incident/notification link, acknowledgement timestamp, and recovery
timestamp. A two-region readiness incident requires both configured regions to
fail inside the alert window; one-region failure is warning-only. The repository
validator checks required IDs and evidence references but cannot claim a provider
alert exists without this operator evidence.

Alert tests never interrupt production PostgreSQL, Redis, workers, or customer
traffic. Readiness/dependency tests run on an isolated candidate deployment with
dependency proxies. Log alerts use uniquely tagged synthetic log events. Platform
alerts use provider test-notification features or a disposable test job. Uptime
tests briefly target a release-specific staged endpoint, never the production
domain. Production evidence confirms healthy routing/configuration after tests.

The operational health script performs read-only checks for overdue/exhausted
Stripe webhook inbox records, messaging jobs, transactional notification intents,
and refund reconciliation/manual-review work. It emits counts and stable category
codes only and exits nonzero when action is required. Operators locate individual
records through authenticated admin views or the runbook's bounded, read-only
database queries filtered by status and time; the monitoring event never emits row
IDs or customer/provider fields. A scheduled DigitalOcean job runs it; job failure
is itself alerted.

## Launch Procedure and Evidence Gate

Provider canaries use dedicated launch resources and are non-customer-facing:

- **Clerk:** obtain a short-lived session for a dedicated production canary user
  with no admin role, call the authenticated identity endpoint, and prove expected
  issuer, API audience, authorized party, subject fingerprint, 200 response, and
  wrong-audience rejection. Retain no token or profile data.
- **Stripe:** retrieve and compare the account fingerprint, require live-mode
  application credentials, and record Stripe Workbench evidence that the exact
  live HTTPS endpoint and enabled event types are active. Separately, an operator
  command signs a synthetic, live-shaped `payment_intent.succeeded` payload with
  the production webhook secret and a reserved `evt_launch_canary_*` ID plus a
  random unknown order reference. The actual webhook route must verify it,
  durably record/ignore it, and produce zero order/payment/refund mutations. This
  local signature probe does not claim Stripe delivered the event; Workbench
  endpoint configuration evidence proves provider routing. Record only event ID,
  expected live mode, bounded outcome, and request ID.

  The event carries a signed `kapchi_launch_canary=true` marker and is persisted
  with `ingressSource: "local_signature_canary"`, never
  `providerDelivered: true`. It becomes terminal `processed` immediately and is
  excluded from provider-delivery/livemode assertions, retry claims,
  operational-health counts, and webhook failure alerts. Queries and evidence
  label it `synthetic-handler-proof`, not a Stripe delivery.
- **Blob:** upload a tiny generated file under
  `launch-canary/<release-sha>/<random-id>`, verify unauthenticated denial and
  authorized canary-admin byte/content-type success through the application, then
  delete the provider object and mark/remove canary metadata through the supported
  cleanup path. Record only hashes, statuses, and provider evidence URL.
- **Messaging:** send one message to `MESSAGE_CANARY_DESTINATION`, a deployment
  allowlisted internal inbox/number that cannot be supplied by an API caller.
  Prove durable queued/sent/provider-delivered state and webhook signature handling;
  record message/provider IDs and bounded status only. The runbook deletes the
  provider test message where supported but retains redacted durable audit state.

Each canary command requires `--release-sha`, an exact canary-resource
confirmation, and production environment validation. It refuses arbitrary
customer addresses, order IDs, asset keys, or payment objects.

Canaries may mutate only their allowlisted canary resources: one synthetic Stripe
inbox event, one Blob object plus its canary metadata, and one internal messaging
delivery. They must never mutate customer, order, cart, payment, refund,
inventory, or fulfillment state, and Blob cleanup must be evidenced.

The launch record requires:

- release commit and image/deployment identifiers;
- client/API domains and certificate verification;
- named release, database, payments, auth, messaging, and incident owners;
- secret inventory confirmation and rotation date without values;
- backup identifier and restore-drill evidence;
- migration preflight/apply/check job timestamps and links;
- public health/readiness, CORS, Clerk audience, Stripe signed webhook, Blob
  private-read denial/success, and messaging canary evidence;
- alert test evidence for every required alert;
- smoke tests for browse, cart, checkout test/live-safe validation, admin order,
  and webhook processing;
- observation-window start/end and dashboard/log links;
- explicit blockers, rollback decision, and final `GO` or `NO-GO` signed by the
  release owner.

Add `npm run release:validate -- --record <path>` to validate structure, required
fields, timestamps, commit consistency, evidence URI shape, and the go/no-go
rules. `GO` is rejected while any required check is missing, failed, stale, or
still a placeholder. The validator never follows evidence links or reads secrets.

### Acceptance-to-evidence matrix

| #114 acceptance criterion | Repository artifact/test | Required production evidence | Owner | Pass condition |
| --- | --- | --- | --- | --- |
| Topology, ownership, URLs, environment ownership | topology and environment runbooks; template validator | Vercel/DO project links, exact same-site domains, redacted env-name exports | release owner | every component and variable has one owner/platform; HTTPS domains match record |
| Secret-name inventory, no values | inventory validator and pinned Gitleaks CI scan of tracked tree plus PR diff | platform secret-name exports and rotation timestamps | security/release owner | scan passes; no value appears in source/evidence |
| Exactly-once compatible migrations | advisory-lock/checksum database tests and `db:migrate:check` | pre-deploy job log, SHA/image match, baseline evidence if required | database owner | one successful apply/check; no pending/drift/null checksum |
| Public health/readiness and traffic gate | health tests, App Spec validator, external verifier | public `/health` and `/ready` results plus platform health configuration | release owner | 200/expected SHA before promotion; isolated candidate dependency-proxy test yields 503/no traffic |
| HTTPS, CORS, Clerk, Stripe, Blob | environment/auth/CORS tests and provider canary commands | certificate, origin allow/deny, Clerk, Stripe, Blob canary evidence | auth/payments/assets owners | every expected success and denial passes with no customer/commerce mutation; temporary provider resources are cleaned up while isolated audit/idempotency records remain |
| Backup/retention/restore drill | restore guard tests and sanitized local drill | plan/retention proof, encrypted backup proof, managed restore-to-new-cluster and destruction evidence | database owner | provider drill <=30 days old; integrity/reconciliation pass |
| App/database rollback and roll-forward | N/N-1 compatibility test and decision checklist | staged rollback rehearsal links and decision record | release/database owners | previous client/API works on current schema or launch is NO-GO |
| Actionable alerts | alert inventory/query/template validators | exported config plus forced incident notification/ack/recovery per alert | incident owner | every required alert test-delivers to primary and secondary paths |
| Launch checklist and decision | launch-record validator | immutable completed record | release owner | all checks fresh/pass and signed GO; otherwise NO-GO |
| Production seed/reset blocked | production-mode mutation-spy tests; Gitleaks CI | preflight output | release owner | every unsafe command fails before DB/provider mutation |

Repository CI adds a pinned Gitleaks workflow that scans the tracked repository
and pull-request diff. Production launch additionally records GitHub secret
scanning/push-protection status. A scan failure blocks merge and GO.

## Production Safety Tests

- Environment tests cover production CORS, Clerk audience, direct database URL,
  Blob strategy, messaging all-or-none validation, and redacted failures.
- Auth tests prove audience and issuer enforcement.
- Health tests cover independent liveness, all-ready response, each dependency
  failure, 503 shape, and redacted logs.
- Migration unit/database tests cover direct URL selection, advisory locking,
  concurrent apply, rollback/retry, drift, pending status, and read-only check.
- Deployment/runbook validators parse all templates and reject missing required
  health, migration, alert, owner, timestamp, and evidence fields.
- Production-mode regression tests prove `db:migrate:reset`, `db:seed:local`,
  Stripe test-catalog sync, and E2E reset commands fail before a database/provider
  mutation. Guarded fixture initialization belongs to #85/PR #131 and is tested
  here only if that prerequisite has merged before implementation.
- External verifier tests use a local fake HTTPS server or mocked fetch and cover
  certificate/protocol, CORS allow/deny, readiness failure, timeout, and response
  redaction.
- Restore-drill tests cover every target guard and sanitized evidence output;
  the actual drill uses only synthetic/non-production data.

Migration database tests require a dedicated database name containing
`issue114_test`, a server-side `kapchi_test_database` marker, and an exact typed
confirmation. They reject the normal development database. Concurrent behavior
uses child processes, a 2-second test lock timeout, and deterministic cleanup of
only marker-owned databases/rows. A before/after ledger digest proves
`db:migrate:check` performs no writes.

## Fixed Cross-Slice Interfaces

- Readiness dependency codes are exactly `DATABASE_UNAVAILABLE`,
  `REDIS_UNAVAILABLE`, `MIGRATIONS_PENDING`, `MIGRATION_DRIFT`,
  `PRIVATE_ASSET_PROVIDER_UNCONFIGURED`, and `READINESS_TIMEOUT`. The response is
  `{ status, releaseSha, releaseImageDigest, dependencies: { database, redis, migrations,
  privateAssetProvider }, failedDependencyCodes }`; dependency values are only
  `ready|unready|unconfigured`.
- Migration CLI exit codes are `0` success, `10` unsafe/invalid configuration,
  `11` lock timeout, `12` pending migration, `13` ledger/checksum drift, and `14`
  migration execution failure. JSON failure output contains only `event`,
  `errorCode`, `migrationId?`, and `runId`.
- Operational-health output is
  `{ event: "operations.health.completed", releaseSha, checkedAt,
  actionable, counts: { stripeWebhooks, messageJobs, notificationIntents,
  refundReconciliations, manualReviewRefunds } }`. It emits counts only, never row
  IDs or customer/provider fields; exit `0` means no action and `20` means action
  required.
- Required launch-record evidence keys are `topology`, `secrets`, `migration`,
  `health`, `auth`, `stripe`, `blob`, `messaging`, `backup`, `restoreDrill`,
  `rollbackRehearsal`, `alerts`, `smoke`, `observation`, and `decision`. Each has
  `owner`, `status`, `checkedAt`, `releaseSha`, and one or more HTTPS/provider
  evidence references. `decision` additionally has `value`, `signedBy`, and
  `signedAt`.

## Implementation Slices

After three reviewers approve this spec, two agents work in parallel with
disjoint write sets:

1. **Runtime and migration controls:** environment schema, CORS, Clerk audience,
   readiness, migration locking/checking, operational health command, and backend
   worker/tests. This agent owns only `backend/src/config/**`,
   `backend/src/app.ts`,
   `backend/src/modules/auth/**`, `backend/src/modules/health/**`,
   `backend/src/modules/assets/**`,
   `backend/src/plugins/**`, `backend/src/database/migrate*`,
   one issue-114-owned migration under `backend/src/database/migrations/`,
   `backend/src/operations/**`, and `backend/src/worker*`. It may add tests beside
   those files and owns `client/app/api/blob/upload/**`, `client/lib/api.ts`,
   `client/components/Navbar.tsx` plus its tests, and `client/next.config.ts` for
   removal of the generic proxy. It does not edit package manifests,
   Docker/deploy files, scripts, or docs.
2. **Deployment and runbook system:** backend Dockerfile, DigitalOcean template,
   external verifier, restore drill, environment/launch/backup/rollback docs,
   provider-canary contracts, alert inventory, launch-record validator, Gitleaks
   workflow, and tests. This agent owns only `backend/Dockerfile`, `deploy/**`,
   `scripts/**`, `docs/runbooks/**`, and `.github/workflows/production-readiness.yml`.
   It does not edit backend runtime source or package manifests.

The shared interface is fixed by this spec: readiness dependency codes,
`RELEASE_SHA`, migration command exit codes, operational-health JSON fields, and
launch-record evidence keys. The parent agent alone edits `backend/package.json`,
root/client manifests if needed, `.env.example` files, and this spec after agent
work returns. It integrates both slices, runs backend/client unit tests,
typechecks and builds, exercises validators and the restore drill on disposable
local data, checks templates for secret values, and opens one PR referencing
issue #114.

## Completion Boundary

The PR is code-complete when all repository controls and synthetic/local tests
pass. Issue #114 is launch-complete only after a production operator fills a
valid launch record with external provider evidence, including the managed
restore drill and tested alert delivery. Until then the PR must say it prepares
#114 and must not auto-close the issue.
