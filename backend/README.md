# Backend

This backend workspace currently includes:

- centralized environment configuration
- Fastify bootstrap
- security/runtime plugins
- PostgreSQL connection pooling
- structured error handling
- Clerk JWT verification
- reusable auth guards:
  - `authMiddleware`
  - `requireAuth`
  - `requireRole`
  - `requirePermission`
- module registration points for:
  - assets
  - users
  - listings
  - cart
  - payments
  - shipping

Some domain modules are still skeletal. Asset upload authorization and customer
order lookup are wired.

## Requirements

- Node.js `>= 20.9.0`
- npm
- PostgreSQL for local development
- Redis for local development

## Fresh Local Setup

From a fresh checkout, install dependencies and create a local backend env file:

```bash
cd backend
npm install
cp .env.example .env
```

The example file uses placeholder values only. Replace third-party service and
database placeholders in `backend/.env` when you need those integrations, but do
not commit real secrets.

## Local PostgreSQL Setup

The backend expects a PostgreSQL database available through `DATABASE_URL`. The
examples below use a local-only database named `kapchi_local`, a local role named
`kapchi_local`, and the placeholder password `replace_me_local_password`. Use a
different local password if you prefer and update `backend/.env` to match.

### Start PostgreSQL

Use an existing local PostgreSQL install, or start one with Docker.

Homebrew on macOS:

```bash
brew install postgresql@16
brew services start postgresql@16
```

Docker:

```bash
docker run --name kapchi-postgres \
  -e POSTGRES_USER=kapchi_local \
  -e POSTGRES_PASSWORD=replace_me_local_password \
  -e POSTGRES_DB=kapchi_local \
  -p 5432:5432 \
  -d postgres:16
```

If you already have a PostgreSQL container with that name, start it instead:

```bash
docker start kapchi-postgres
```

### Create The Local Database

For a Homebrew or otherwise unmanaged local PostgreSQL instance, create the role
and database manually:

```bash
createuser --createdb kapchi_local
psql postgres -c "alter user kapchi_local with password 'replace_me_local_password';"
createdb --owner=kapchi_local kapchi_local
```

If the role or database already exists, PostgreSQL may print an error. That is
fine when your local objects are already in place.

The Docker command above creates the role and database automatically on first
container startup.

### Configure Backend Database Variables

Keep these local development values in `backend/.env` unless your local
PostgreSQL setup uses a different host, port, database, user, or password:

```bash
DATABASE_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
DATABASE_DIRECT_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=15000
DATABASE_SSL_MODE=disable
DATABASE_MAX_CONNECTIONS=20
DATABASE_RESERVED_CONNECTIONS=5
DATABASE_MAX_APP_INSTANCES=3
```

Use `DATABASE_URL` for runtime traffic. Use `DATABASE_DIRECT_URL` for migration
or admin commands that need a direct, non-pooled connection.

### Check Connectivity

After PostgreSQL is running and `backend/.env` is configured, verify that the
backend can reach the database:

```bash
psql "$DATABASE_URL" -c "select current_database(), current_user;"
```

If your shell has not loaded `backend/.env`, pass the local URL directly:

```bash
psql "postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local" \
  -c "select current_database(), current_user;"
```

You should see `kapchi_local` for both the current database and current user.

### Reset The Local Database

Resetting destroys local data. Stop the backend before running reset commands.

For Homebrew or another local PostgreSQL service:

```bash
dropdb --if-exists kapchi_local
createdb --owner=kapchi_local kapchi_local
```

For the Docker container:

```bash
docker rm -f kapchi-postgres
docker volume prune
docker run --name kapchi-postgres \
  -e POSTGRES_USER=kapchi_local \
  -e POSTGRES_PASSWORD=replace_me_local_password \
  -e POSTGRES_DB=kapchi_local \
  -p 5432:5432 \
  -d postgres:16
```

Only prune Docker volumes when you are comfortable deleting unused local Docker
volumes. If you keep other local databases in Docker, remove only the volume for
this container instead.

## Local Redis Setup

The backend requires Redis during startup. The local placeholder URL is
`redis://localhost:6379`; keep it in `backend/.env` unless your Redis instance
uses a different host, port, database, or password.

### Start Redis

Use an existing local Redis install, or start one with Docker.

Homebrew on macOS:

```bash
brew install redis
brew services start redis
```

Docker:

```bash
docker run --name kapchi-redis \
  -p 6379:6379 \
  -d redis:7-alpine
```

If you already have a Redis container with that name, start it instead:

```bash
docker start kapchi-redis
```

### Configure Backend Redis Variables

Keep this local development value in `backend/.env` unless your local Redis
setup differs:

```bash
REDIS_URL=redis://localhost:6379
```

Do not put production Redis credentials in `.env.example` or commit them to the
repository. Use a secret manager or deployment environment variables for shared
or hosted Redis instances.

### Check Connectivity

After Redis is running, verify that it responds before starting the backend.

For the Docker container above:

```bash
docker exec kapchi-redis redis-cli ping
```

For a local `redis-cli` install:

```bash
redis-cli -u redis://localhost:6379 ping
```

Both commands should print `PONG`.

### Redis-Backed Features

The backend registers the Redis client at startup and exits if Redis is
unreachable. Current Redis-backed behavior includes:

- guest cart session lookup and creation for the `session_id` cookie
- seven-day guest session storage under `guest_session:<hashed-session-id>` keys
- guest cart item reads under `guest_cart:<cart-id>:items` keys

The parent Redis infrastructure work tracks broader use for sessions, guest
carts, caching, and background jobs. Add any new Redis-backed feature here when
it lands so local setup stays accurate.

## Environment Variables

Create a local env file in `backend/.env`:

```bash
cp .env.example .env
```

Replace the placeholder values before running the backend. Do not commit real
production secrets.

### Redis Secret Hygiene

`backend/.env.example` uses `REDIS_URL=redis://localhost:6379` as a local-only
placeholder. Keep real Redis URLs, usernames, passwords, and provider tokens in
untracked local env files or the deployment platform's secret manager.

For production, configure `REDIS_URL` as a runtime secret in the hosting
provider, for example DigitalOcean App Platform encrypted environment variables,
using the managed Redis provider's connection string. Do not paste production
Redis credentials into README snippets, issue comments, screenshots, committed
`.env` files, or test fixtures.

If a production Redis credential has been committed or otherwise exposed, rotate
or revoke the Redis user/password/token in the provider, update the deployment
secret, redeploy, and invalidate the old credential. Treat a redacted git diff
as insufficient unless the provider-side credential has also been rotated.

Future CI should include secret scanning before merge, such as GitHub secret
scanning with push protection plus a Gitleaks or TruffleHog job if this repo adds
custom GitHub Actions workflows.

For Stripe payment flow verification, including Checkout success, failed
payments, cancellation or expiration, duplicate webhook delivery, required
placeholder environment variables, Stripe CLI setup, and database checks, see
[`docs/payment-verification.md`](docs/payment-verification.md).

### Customer Image Asset Uploads

Customer-uploaded customization images are stored in Vercel Blob, while
PostgreSQL owns the canonical provider-neutral `assets` row. The domain model
uses `provider`, `storage_key`, `url`, `content_type`, `byte_size`, `checksum`,
`visibility`, `context`, and ownership/linkage fields so the storage adapter can
move to Cloudflare R2 later without rewriting cart, order, or customization
records.

The Fastify backend is the source of truth for upload authorization and asset
metadata:

- `POST /assets/upload-intents` validates the actor, upload context, content
  type, size, and cart/listing/fabric ownership before creating a pending asset
  row.
- `POST /assets/upload-token-authorizations` revalidates a pending intent before
  the Next.js Vercel Blob route issues a client upload token.
- `POST /assets/upload-completions` finalizes the pending asset row after Vercel
  Blob reports the upload metadata.

Supported contexts:

| Context | Who can upload | Visibility default |
| --- | --- | --- |
| `customization_image` | Authenticated customer or guest with the matching active cart session, active graduation stole listing, and image-enabled customization set | `private` |
| `catalog_listing_image` | Admin role or catalog/listing asset permission | `public_catalog` |
| `fabric_image` | Admin role or fabric/catalog asset permission | `public_catalog` |

Guest sessions are resolved through the `session_id` cookie and Redis session
record. The raw session token is never stored in PostgreSQL; guest uploads link
to the cart id and hashed guest cart ownership already used by the backend.

Backend variables:

```bash
ASSET_UPLOAD_ALLOWED_IMAGE_TYPES=image/jpeg,image/png,image/webp
ASSET_UPLOAD_MAX_IMAGE_BYTES=5242880
ASSET_UPLOAD_CALLBACK_SECRET=replace_me_shared_callback_secret
```

Use the same `ASSET_UPLOAD_CALLBACK_SECRET` in the Next.js runtime so only the
frontend's Vercel Blob callback adapter can finalize uploads. Configure the real
secret in deployment environment variables, not in committed files.

Local Vercel Blob callback behavior depends on Vercel being able to reach the
Next.js callback route. Use a tunnel such as ngrok and set
`VERCEL_BLOB_CALLBACK_URL` in `client/.env` when testing the full callback flow
locally.

### PostgreSQL Connection Pooling

The backend uses one shared `pg.Pool`, exposed to Fastify as `app.pg`. Request
handlers that need a checked-out client should use `app.withPgClient(...)` so
clients are always released.

Runtime traffic should use `DATABASE_URL`. Migration and admin scripts should
use `DATABASE_DIRECT_URL` when a direct, non-pooled connection is required.
Keep schema migrations outside the application request pool.

Pool and deployment variables:

```bash
DATABASE_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
DATABASE_DIRECT_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=15000
DATABASE_SSL_MODE=disable
DATABASE_MAX_CONNECTIONS=20
DATABASE_RESERVED_CONNECTIONS=5
DATABASE_MAX_APP_INSTANCES=3
```

Pool settings:

| Variable | Purpose |
| --- | --- |
| `DATABASE_POOL_MAX` | Maximum PostgreSQL connections one app instance can hold. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Maximum time to wait while opening or checking out a connection. |
| `DATABASE_IDLE_TIMEOUT_MS` | Time an idle connection may remain in the pool before closing. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Per-statement timeout sent to PostgreSQL for app queries. |
| `DATABASE_SSL_MODE` | `disable` locally, `require` in production, or `no-verify` only for providers that require TLS without a trusted CA chain. |

Deployment budget settings:

| Variable | Purpose |
| --- | --- |
| `DATABASE_MAX_CONNECTIONS` | The deployment target database connection cap from the provider plan. |
| `DATABASE_RESERVED_CONNECTIONS` | Connections kept available for migrations, admin consoles, maintenance jobs, monitoring, and emergency access. |
| `DATABASE_MAX_APP_INSTANCES` | Maximum concurrently running backend instances for the deployment. |

The launch budget assumes a managed PostgreSQL target with at least 20 total
database connections. If the provider plan advertises a different cap, set
`DATABASE_MAX_CONNECTIONS` to that exact number before deploying.

`DATABASE_POOL_MAX` is the maximum number of PostgreSQL connections each app
instance can hold. The app validates this deployment budget at startup:

```txt
DATABASE_POOL_MAX <= floor((DATABASE_MAX_CONNECTIONS - DATABASE_RESERVED_CONNECTIONS) / DATABASE_MAX_APP_INSTANCES)
```

For the defaults, the app may run up to 3 instances with a pool size of 5:

```txt
floor((20 - 5) / 3) = 5
```

The same values mean the app can use at most 15 PostgreSQL connections across 3
instances, leaving 5 connections outside the request path. Increase
`DATABASE_MAX_CONNECTIONS` only when the database plan actually supports the
higher limit.

Use `DATABASE_SSL_MODE=require` in production when the provider supplies a
certificate chain trusted by Node.js. Use `DATABASE_SSL_MODE=no-verify` only
when the provider requires TLS but does not yet provide CA configuration for
certificate verification. Local development can use `disable`.

### Deployment Limits

Recommended starting values for the current launch target:

| Environment | Max app instances | Pool max | Reserved | DB max connections |
| --- | ---: | ---: | ---: | ---: |
| Local | 1 | 5 | 2 | 20 |
| Preview | 1 | 3 | 5 | 20 |
| Production | 3 | 5 | 5 | 20 |

For serverless deployments, set `DATABASE_POOL_MAX=1` unless all app traffic
uses a provider-level pooler such as PgBouncer or the database provider's pooled
connection endpoint. In serverless mode, each warm function instance can own its
own pool, so instance concurrency can multiply database usage quickly. For
long-running Node processes, keep the pool small and scale by updating
`DATABASE_MAX_APP_INSTANCES` and the database plan together.

Readiness checks use the existing Fastify PostgreSQL pool and run `select 1`;
they do not create a second pool. Keep external load balancer health-check
intervals conservative enough that readiness traffic cannot dominate the pool.

Tune pool settings in this order:

1. Confirm the provider's actual PostgreSQL connection cap and update `DATABASE_MAX_CONNECTIONS`.
2. Reserve non-app capacity with `DATABASE_RESERVED_CONNECTIONS`.
3. Set `DATABASE_MAX_APP_INSTANCES` to the highest number of backend instances the platform can run at once.
4. Recalculate `DATABASE_POOL_MAX` with the startup formula above.
5. Increase the database plan before increasing app instances beyond the formula.

### Production PostgreSQL Secret Hygiene

Configure production `DATABASE_URL` and `DATABASE_DIRECT_URL` only in the
deployment provider's encrypted environment or secret manager. Do not commit
production `.env` files, database console exports, screenshots, connection URLs,
usernames, passwords, certificates, or access tokens to this repository.

For DigitalOcean App Platform, set the PostgreSQL connection strings as runtime
environment variables or managed database bindings on the backend service. Keep
`DATABASE_DIRECT_URL` restricted to migrations or admin jobs that need a direct
connection, and use the provider's pooled connection endpoint for `DATABASE_URL`
when the production database plan requires pooling.

If any real database credential is exposed in git, logs, screenshots, tickets,
or chat, rotate or revoke it in the database provider before redeploying. The
owner of the deployment credentials is responsible for confirming rotation and
updating the provider-side environment values; do not record the replacement
secret in git.

The repository includes `.gitleaks.toml` with PostgreSQL URL and database
password checks. Run this before pushing secret-sensitive changes:

```bash
gitleaks detect --source . --config .gitleaks.toml
```

When CI workflows are added to this repository, wire that same Gitleaks command
into pull request checks. Also enable GitHub secret scanning and push protection
for the repository if the account plan supports them.

## Scripts

```bash
npm install
npm run dev
npm run db:seed:local
npm test
npm run test:watch
npm run typecheck
npm run build
```
