# Issue 114: Production Launch Readiness Specification

Status: corrected for the Vercel backend topology on 2026-11-05.

## Objective

Provide a repeatable, evidence-backed launch process for a Next.js storefront
and Fastify API deployed as separate Vercel projects from the same repository.
The process must fail closed on configuration, schema, provider, security,
backup, alerting, or rollback gaps.

## Architecture

| Component | Deployment | Responsibility |
| --- | --- | --- |
| Storefront | Vercel project rooted at `client/` | Next.js pages, browser auth, Blob upload exchange |
| API | Vercel project rooted at `backend/` | Fastify routes, webhooks, admin APIs, metadata |
| Scheduled work | Vercel Cron calling bounded API routes | messages, refunds, inventory, retention, health |
| PostgreSQL | managed provider connected to API | durable commerce state and migration history |
| Redis | managed TLS provider connected to API | cart state, rate state, distributed cron locks |
| Blob | Vercel Blob | catalog and customer artwork bytes |

The projects use same-site custom HTTPS domains. Preview domains do not prove
the production cookie contract; staging acceptance uses same-site staging
domains.

## Runtime Contract

Vercel detects `backend/src/server.ts` and deploys the Fastify application as a
single function. There is no permanent worker process, pre-deploy container
hook, or image digest. `/health` and `/ready` report the full Git SHA and backend
Vercel deployment ID.

`deploy/vercel.crons.pro.template.json` defines the required five authenticated
GET cron schedules. There is no active `backend/vercel.json` until the
project supports minute-level cadence, because Vercel rejects sub-daily cron
expressions on Hobby. Vercel sends `Authorization: Bearer <CRON_SECRET>`. Each route performs constant-time auth,
acquires a token-owned Redis lock, executes one bounded batch, emits structured
start/success/failure logs, and releases only its own lock. Duplicate delivery
returns `202 already_running`. Service-level idempotency remains authoritative.

Minute-level schedules require an eligible Vercel plan. If the account cannot
support them, launch remains blocked until an external scheduler invokes the
same routes at the documented cadence. Preview deployment must remain possible
before that operational purchase or scheduler decision. Fastify otherwise uses
Vercel's zero-configuration detection of `backend/src/server.ts`; configure the
function duration in the backend project's Functions settings.

## Configuration And Secrets

Vercel project settings are the production source of truth. Backend production
startup requires live provider values, exact Clerk audience and authorized
party claims, TLS PostgreSQL and Redis URLs, `CRON_SECRET`, callback signing
keys, and release identity from `VERCEL_GIT_COMMIT_SHA` and
`VERCEL_DEPLOYMENT_ID` or explicit overrides. Secrets never enter the repository,
build arguments, launch records, or command output.

The client and backend share only intentional values, including the Clerk
publishable key and callback-signing contract. Server credentials remain scoped
to the project that consumes them.

## Migration And Promotion

Migrations are forward-compatible and checksum-protected. The protected
`Production database migration` GitHub workflow accepts a full release SHA,
serializes all production runs, checks out that exact commit, pulls the backend
Vercel project metadata, and runs both migration apply and check under `vercel
env run -e production`. GitHub stores only the Vercel token, team ID, and backend
project ID; database credentials remain in Vercel.

The release order is:

1. Validate repository controls and both project builds.
2. Create non-production deployments for the exact SHA.
3. Run provider canaries and same-site staging smoke tests.
4. Confirm backup freshness and complete the protected migration workflow.
5. Promote and verify the backend deployment.
6. Promote and verify the client deployment.
7. Observe the release, record evidence, and sign GO or NO-GO.

## Availability And Recovery

Readiness checks database, Redis, migration state, and private asset access with
bounded timeouts and redacted failure codes. Vercel function errors, duration,
cron logs, external readiness, database saturation, Redis availability, Stripe
webhooks, and durable work backlogs all have named alert contracts.

Rollback selects prior Vercel deployments only when the current schema is
backward compatible. Otherwise the system enters write freeze and rolls forward.
Cron behavior is checked explicitly during rollback because a deployment
rollback does not substitute for scheduler control.

The actual managed PostgreSQL provider's retention and point-in-time recovery
features must be recorded before launch. Restore drills target a disposable,
isolated database and never automate production deletion.

## Acceptance Criteria

- Two Vercel projects have explicit `client/` and `backend/` roots and same-site domains.
- Fastify deploys from `src/server.ts`; no production container or permanent worker is required.
- Production startup rejects insecure, incomplete, or placeholder configuration.
- Cron routes require a strong secret, use distributed locks, have bounded duration, and have tests.
- Migrations are protected, serialized, SHA-bound, checksum-verified, and use Vercel-owned environment values.
- Health, readiness, provider canaries, alerts, backup, restore, rollback, and observation have evidence owners.
- Launch records identify distinct client/backend Vercel deployment IDs and one full Git SHA.
- GO is impossible while any required evidence is missing, stale, failed, or pending.
