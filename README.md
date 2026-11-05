# Kapchi

An online store selling Indigenous graduation products and connecting the
community through a unified cultural identity.

## Local Development

Backend setup, including local PostgreSQL and Redis, database migrations, and
connectivity checks, is documented in [`backend/README.md`](backend/README.md).
The Next.js application is documented in [`client/README.md`](client/README.md).

## Production Deployment

Kapchi uses two Vercel projects connected to this repository:

| Project | Root directory | Runtime |
| --- | --- | --- |
| Storefront | `client/` | Next.js |
| API | `backend/` | Fastify on one Vercel Function |

Use same-site custom domains such as `www.kapchi.com` and `api.kapchi.com` so
credentialed cart and admin requests work predictably. Configure each project's
variables in Vercel; do not copy production credentials into committed files or
GitHub Actions. The backend project owns PostgreSQL, Redis, Stripe, Clerk, Blob,
messaging, callback-signing, and cron values. The client owns browser-safe
public values and its server-only Blob callback values.

`backend/vercel.json` defines bounded cron invocations. Its minute-level
schedules require a Vercel plan that supports that cadence; otherwise configure
an external scheduler with the same `Authorization: Bearer $CRON_SECRET`
contract. The jobs are idempotent and Redis-locked because cron delivery can be
duplicated and is not automatically retried.

Production database changes run through the protected, serialized
`.github/workflows/production-migrate.yml` workflow. It obtains the backend
project's production variables through Vercel CLI without storing database
credentials in GitHub.

The complete launch process is in
[`docs/runbooks/production-launch.md`](docs/runbooks/production-launch.md).
The root `Dockerfile` remains a local/container fallback and is not the
production deployment topology.

GitHub secret scanning and the production-readiness workflow must remain
enabled. Rotate any credential exposed in git, logs, screenshots, or tickets at
its provider before redeploying; deleting the text alone is not remediation.
