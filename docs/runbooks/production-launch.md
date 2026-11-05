# Production Launch

No step may be marked complete without an evidence link tied to one full Git SHA
and the distinct client/backend Vercel deployment IDs.

## Build One Immutable Release

1. Select a reviewed full Git SHA and confirm required CI is green.
2. Confirm the Vercel projects use roots `client/` and `backend/`.
3. Run backend and client tests/builds plus `node --test scripts/*.test.mjs`.
4. Create preview deployments from that SHA; do not rebuild from a moving branch.
5. Record both `dpl_...` IDs and the SHA in a private launch record.

## Preflight

Confirm same-site staging and production domains, Vercel plan support for the
cadence in `deploy/vercel.crons.pro.template.json` or an equivalent external
scheduler, exact auth origins, live Stripe ownership, Blob private
read access, messaging allowlist, current managed-database backup, Redis TLS,
and alert destinations. Run the provider canary contracts without printing
credentials or customer data.

## Execute Provider Canaries

Run the bounded canaries described by `deploy/provider-canaries.json`. Use only
allowlisted internal identities and destinations. Store provider dashboard or
sanitized log references. A timeout, ambiguous account, wrong environment, or
cleanup failure is a launch blocker.

## Migrate And Deploy Backend Components

1. Require an approved, current backup and rollback compatibility decision.
2. Dispatch `Production database migration` with the exact SHA and
   `MIGRATE_PRODUCTION` confirmation.
3. Wait for both apply and checksum verification to pass. Never rerun a failed
   migration blindly; inspect its recorded migration state first.
4. Promote the matching backend preview deployment in Vercel.
5. Run:

```sh
node scripts/verify-production.mjs \
  --api-url https://api.example.invalid \
  --client-url https://www.example.invalid \
  --release-sha FULL_RELEASE_SHA \
  --deployment-id dpl_BACKEND_DEPLOYMENT_ID
```

6. If using Vercel Cron, install the reviewed template as
   `backend/vercel.json`, redeploy, and confirm all five cron routes are present,
   authenticated, and producing success or intentional `already_running` logs.
   Never invoke them with a secret in a URL.
7. Promote the matching client preview and repeat storefront smoke checks.

## Smoke Tests

Verify anonymous browsing, guest cart creation, sign-in cart claim, customized
stole metadata and artwork, Stripe Checkout, duplicate webhook handling, order
lookup, admin denial for non-admins, admin order/artwork access, refund state,
message intent creation, and shipping export. Use sandbox/staging data before
production and one controlled live transaction only when explicitly approved.

## Public Readiness

External monitors must see `/health` and `/ready` over HTTPS. `/ready` must
return `status=ready`, the expected deployment ID and SHA, no failed dependency
codes, and ready database, Redis, migrations, and private asset provider states.

## Observe And Decide

Observe for at least 30 minutes after both promotions. Review Vercel function
errors and duration, cron logs, backend 5xx rate, readiness, PostgreSQL and Redis
signals, Stripe webhooks, durable job backlogs, and message delivery. Exercise
every stable alert route to primary and secondary destinations without causing
customer impact.

Sign `GO` only when every launch-record section passes, no blocker remains, and
the observation window has ended. Otherwise sign `NO-GO` and execute the
rollback runbook.
