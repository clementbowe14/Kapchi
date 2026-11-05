# Production Launch

This is the single ordered procedure for a Kapchi production release. Automatic
production promotion stays disabled in Vercel and DigitalOcean. Every component
uses one immutable Git SHA; the API, worker, migration job, and operational-health
job use one digest-pinned backend image. Create a release-specific copy of the
launch record before step 1 and update it as evidence is produced.

## 0. Assign Owners And Open The Gate

Name release, database, payments, auth, messaging, assets/security, and incident
owners. Confirm a primary and secondary incident destination. Verify the client
and API are distinct same-site HTTPS custom domains. A release owner must be
available throughout the observation window; no delegate may sign on an unnamed
owner's behalf.

Run repository controls:

```sh
node scripts/validate-deployment.mjs
node scripts/validate-alerts.mjs
node scripts/provider-canary.mjs validate-contracts
node --test scripts/*.test.mjs
```

Confirm the pinned Gitleaks job passed for the tracked tree and PR diff, GitHub
secret scanning/push protection is enabled, and platform environment exports
contain the names in `production-environment.md` without values. Any finding is a
blocker.

## 1. Build One Immutable Release

Checkout the exact full Git SHA. Build the backend-only image from repository
root, push it once, and resolve the registry's immutable `sha256:` digest:

```sh
docker build --file backend/Dockerfile --tag BACKEND_IMAGE_NAME .
```

Build the Vercel client from the same SHA as an unpromoted staged deployment.
Record the Git SHA, Vercel deployment ID, backend digest, and the same digest as
the worker digest. Do not use a mutable image tag in the App Spec.

## 2. Prepare Recovery And Compatibility

Confirm DigitalOcean backup policy/plan and create the encrypted pre-launch
logical backup described in `production-backup-restore.md`. Link a passing managed
restore-to-new-cluster drill no older than 30 days. Complete the N/N-1 staged
compatibility rehearsal from `production-rollback.md`. Missing backup, stale
restore evidence, or incompatibility is `NO-GO`.

For the first checksum-aware release only, the database owner compares an
approved schema-dump hash with the expected schema and records that evidence.
Then run the baseline command from the exact candidate image, typing the exact
database name as confirmation:

```sh
npm run db:migrate:baseline-checksums -- --confirm-database EXACT_DATABASE_NAME
npm run db:migrate:check
```

Do not baseline unknown IDs, name mismatches, or a schema that has not received
owner approval. Later releases must never use baseline as a drift repair.

## 3. Validate Configuration And Providers

Run the integrated production environment preflight. It must validate same-site
origins, Clerk instance/audience/authorized party, Stripe live account
fingerprint, direct TLS database URL, TLS Redis, private Blob strategy, messaging
all-or-none configuration, callback/webhook secret strength, and release
identity. Store only bounded fingerprints and status codes.

Check the Stripe Workbench live endpoint URL and event subscriptions. Confirm the
Clerk canary user has no admin role, the Blob canary store/prefix is dedicated,
and `MESSAGE_CANARY_DESTINATION` is an allowlisted internal destination.

## 4. Migrate And Deploy Backend Components

Fill a private operator copy of `deploy/digitalocean.backend.template.yaml` with
resource identifiers, domains, the immutable digest, and provider-encrypted
values. Never commit that copy. Submit it explicitly; source control must not
auto-promote.

The `PRE_DEPLOY` job runs migration `apply` and then read-only `check` on a
dedicated direct connection. Require successful checksum/lock evidence, matching
release SHA/image digest, and no pending, null-checksum, or drifted migration.
Wait for both API instances and the singleton worker. DigitalOcean routes traffic
only after `/ready`; `/health` remains the liveness probe.

Run the bounded external verifier before promoting the client:

```sh
node scripts/verify-production.mjs \
  --api-url PRODUCTION_API_URL \
  --client-url PRODUCTION_CLIENT_URL \
  --release-sha RELEASE_SHA \
  --image-digest RELEASE_IMAGE_DIGEST
```

It must prove TLS/HTTPS, matching release identity, all readiness dependencies,
the exact allowed CORS origin, denied foreign origin, protected admin route, and
storefront reachability.

## 5. Execute Provider Canaries

First run each fail-closed plan command with the exact contract confirmation:

```sh
node scripts/provider-canary.mjs plan --provider PROVIDER --release-sha RELEASE_SHA --confirm EXACT_PROVIDER_CONFIRMATION
```

The planner never executes provider mutations. The integrated runtime commands
must then produce the following evidence:

- Clerk: dedicated non-admin identity succeeds for issuer/audience/`azp`; wrong
  audience is denied; token/profile data is discarded.
- Stripe: live account fingerprint matches; Workbench endpoint evidence is
  attached; one reserved signed synthetic event is terminally ignored with zero
  order/payment/refund mutation and is never represented as provider-delivered.
- Blob: one generated `launch-canary/<sha>/<random>` object denies anonymous
  read, permits canary-admin byte/content-type read, and is deleted with cleanup
  evidence.
- Messaging: one delivery reaches only the configured internal destination and
  proves queue, sent, delivered, and signed webhook states.

If runtime canary endpoints have not been integrated, the planner reports that
explicitly and the launch remains `NO-GO`. Never substitute a customer identity,
address, order, asset, payment, or refund.

## 6. Configure And Test Alerts

Follow `production-alerts.md`. Configure Better Stack monitors/log queries and
DigitalOcean App/database alerts. Safely test every stable alert ID and both
notification paths. Record configuration, notification, acknowledgement, and
recovery links. Re-run healthy routing checks after each staged monitor test.

## 7. Promote Client And Run Smoke Tests

Promote the staged Vercel deployment only after steps 1-6 pass. In a real browser:

1. browse listings and select a fabric/customization;
2. add a guest cart item, reload, and prove the same-site cookie preserves it;
3. sign in and claim the cart without losing text, image, trim, or quantity;
4. complete the approved live-safe checkout validation;
5. verify webhook processing and admin order visibility;
6. verify authorized customer-artwork access and unauthorized denial;
7. verify a transactional status notification using only the canary destination.

Record request IDs and bounded order/canary identifiers, not customer data or
tokens.

## 8. Observe And Decide

Observe health/readiness, 5xx, checkout, Stripe inbox, worker operations,
messaging, refunds, database connections, and Redis for at least 30 minutes after
the final smoke action. Any unresolved alert, failed canary, exhausted job,
evidence placeholder, or blocker requires `NO-GO` or rollback.

Validate the immutable record:

```sh
node scripts/validate-launch-record.mjs --record path/to/release-record.json
```

The release owner signs `GO` only after the observation window ends and all
fifteen evidence sections pass. On failure, sign `NO-GO`, follow
`production-rollback.md`, and preserve evidence for the incident review. Issue
114 remains open until a real production record passes this gate.
