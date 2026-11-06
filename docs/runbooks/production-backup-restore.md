# Production Backup And Restore

The database owner records the actual managed PostgreSQL provider, purchased
plan, automatic backup cadence, retention, point-in-time recovery window, region,
encryption, and restore procedure. Do not infer these from Vercel hosting.

## Pre-Launch Backup

Create or verify a provider-managed recovery point immediately before migration.
Record only its opaque provider reference and timestamp. A backup older than the
approved recovery objective blocks launch.

## Disposable Target Preparation

Create an isolated target with separate credentials, no production network
access, no webhooks, no message delivery, no Stripe live key, and no customer
traffic. The operator confirms the target name and ownership before running a
restore drill.

## Restore Drill

Use `scripts/restore-drill.mjs guard` to validate source and target safety, then
use the provider's restore operation. No plaintext dump is written by the
repository tooling. Verify migration checksums, table counts, representative
foreign keys, and application reads using sanitized assertions. Store timings
and provider references, never row data or credentials.

## Safety Rules

Never automate database deletion. Never restore over production. Never connect
a restored target to production Stripe, Clerk, messaging, Blob callbacks, Redis,
or cron schedules. Cleanup is a separately approved provider-console action.
