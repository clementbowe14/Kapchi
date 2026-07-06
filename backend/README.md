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
- empty module registration points for:
  - users
  - listings
  - cart
  - payments
  - shipping

No business logic has been implemented for domain modules yet.

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

The example file uses local-only placeholder values. Replace third-party service
placeholders with development credentials when you need those integrations, but
do not commit real secrets.

## Local PostgreSQL Setup

The backend expects a PostgreSQL database named `kapchi` owned by a local role
named `kapchi`. The placeholder password in local docs and `.env.example` is
`kapchi`; use a different local password if you prefer and update
`backend/.env` to match.

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
  -e POSTGRES_USER=kapchi \
  -e POSTGRES_PASSWORD=kapchi \
  -e POSTGRES_DB=kapchi \
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
createuser --createdb kapchi
psql postgres -c "alter user kapchi with password 'kapchi';"
createdb --owner=kapchi kapchi
```

If the role or database already exists, PostgreSQL may print an error. That is
fine when your local objects are already in place.

The Docker command above creates the role and database automatically on first
container startup.

### Configure Backend Database Variables

Keep these local development values in `backend/.env` unless your local
PostgreSQL setup uses a different host, port, database, user, or password:

```bash
DATABASE_URL=postgresql://kapchi:kapchi@localhost:5432/kapchi
DATABASE_DIRECT_URL=postgresql://kapchi:kapchi@localhost:5432/kapchi
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
psql "postgresql://kapchi:kapchi@localhost:5432/kapchi" \
  -c "select current_database(), current_user;"
```

You should see `kapchi` for both the current database and current user.

### Reset The Local Database

Resetting destroys local data. Stop the backend before running reset commands.

For Homebrew or another local PostgreSQL service:

```bash
dropdb --if-exists kapchi
createdb --owner=kapchi kapchi
```

For the Docker container:

```bash
docker rm -f kapchi-postgres
docker volume prune
docker run --name kapchi-postgres \
  -e POSTGRES_USER=kapchi \
  -e POSTGRES_PASSWORD=kapchi \
  -e POSTGRES_DB=kapchi \
  -p 5432:5432 \
  -d postgres:16
```

Only prune Docker volumes when you are comfortable deleting unused local Docker
volumes. If you keep other local databases in Docker, remove only the volume for
this container instead.

## Environment Variables

Create a local env file in `backend/.env`:

```bash
cp .env.example .env
```

Replace the placeholder values before running the backend. Do not commit real
production secrets.

### PostgreSQL Connection Pooling

The backend uses one shared `pg.Pool`, exposed to Fastify as `app.pg`. Request
handlers that need a checked-out client should use `app.withPgClient(...)` so
clients are always released.

Runtime traffic should use `DATABASE_URL`. If the production database provider
offers a pooled URL, set `DATABASE_URL` to that pooled URL. Migration and admin
scripts should use `DATABASE_DIRECT_URL` when a direct, non-pooled connection is
required.

Pool and deployment variables:

```bash
DATABASE_URL=postgresql://kapchi:kapchi@localhost:5432/kapchi
DATABASE_DIRECT_URL=postgresql://kapchi:kapchi@localhost:5432/kapchi
DATABASE_POOL_MAX=5
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=15000
DATABASE_SSL_MODE=disable
DATABASE_MAX_CONNECTIONS=20
DATABASE_RESERVED_CONNECTIONS=5
DATABASE_MAX_APP_INSTANCES=3
```

`DATABASE_POOL_MAX` is the maximum number of PostgreSQL connections each app
instance can hold. The app validates this deployment budget at startup:

```txt
DATABASE_POOL_MAX <= floor((DATABASE_MAX_CONNECTIONS - DATABASE_RESERVED_CONNECTIONS) / DATABASE_MAX_APP_INSTANCES)
```

For the defaults, the app may run up to 3 instances with a pool size of 5:

```txt
floor((20 - 5) / 3) = 5
```

Keep `DATABASE_RESERVED_CONNECTIONS` available for migrations, admin consoles,
maintenance jobs, and emergency access. Increase `DATABASE_MAX_CONNECTIONS`
only when the database plan actually supports the higher limit.

Use `DATABASE_SSL_MODE=require` in production when the provider supplies a
certificate chain trusted by Node.js. Use `DATABASE_SSL_MODE=no-verify` only
when the provider requires TLS but does not yet provide CA configuration for
certificate verification. Local development can use `disable`.

### Deployment Limits

Recommended starting values:

| Environment | Max app instances | Pool max | Reserved | DB max connections |
| --- | ---: | ---: | ---: | ---: |
| Local | 1 | 5 | 2 | 20 |
| Preview | 1 | 3 | 5 | 20 |
| Production | 3 | 5 | 5 | 20 |

For serverless deployments, set `DATABASE_POOL_MAX=1` unless all app traffic
uses a provider-level pooler. For long-running Node processes, keep the pool
small and scale by updating `DATABASE_MAX_APP_INSTANCES` and the database plan
together.

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

## Database Migrations

Migration files live in `src/database/migrations` and are plain SQL files that
run in lexical order. The migration runner records applied files in the
`schema_migrations` table.

Create a migration:

```bash
npm run db:migrate:create -- add_order_notes
```

Apply pending migrations:

```bash
npm run db:migrate:apply
```

Inspect migration status and applied history:

```bash
npm run db:migrate:status
npm run db:migrate:history
```

Reset a local database and reapply migrations:

```bash
npm run db:migrate:reset -- --force
```

Reset is intentionally guarded. It only runs when all of these are true:

- `--force` is present
- `NODE_ENV` is not `production`
- `DATABASE_URL` points at `localhost`, `127.0.0.1`, or `::1`
- the database name includes `dev`, `test`, or `local`

Do not run reset commands against staging or production. Production migrations
should be applied through the release process with a managed `DATABASE_URL`,
after review and backup/restore readiness are confirmed.

Migrations are forward-only. To roll back a deployed schema change, create and
review a new migration that reverses or supersedes the previous change. For a
production incident, restore from a verified database backup only through the
hosting provider's operational process.

## Database Configuration

Migration files live in `src/database/migrations` and are plain SQL files that
run in lexical order. The migration runner records applied files in the
`schema_migrations` table.

Create a migration:

```bash
npm run db:migrate:create -- add_order_notes
```

Apply pending migrations:

```bash
npm run db:migrate:apply
```

Inspect migration status and applied history:

```bash
npm run db:migrate:status
npm run db:migrate:history
```

Reset a local database and reapply migrations:

```bash
npm run db:migrate:reset -- --force
```

Reset is intentionally guarded. It only runs when all of these are true:

- `--force` is present
- `NODE_ENV` is not `production`
- `DATABASE_URL` points at `localhost`, `127.0.0.1`, or `::1`
- the database name includes `dev`, `test`, or `local`

Do not run reset commands against staging or production. Production migrations
should be applied through the release process with a managed `DATABASE_URL`,
after review and backup/restore readiness are confirmed.

Migrations are forward-only. To roll back a deployed schema change, create and
review a new migration that reverses or supersedes the previous change. For a
production incident, restore from a verified database backup only through the
hosting provider's operational process.
