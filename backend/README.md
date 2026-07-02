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

Runtime traffic should use `DATABASE_URL`. Migration and admin scripts should
use `DATABASE_DIRECT_URL` when a direct, non-pooled connection is required.
Keep schema migrations outside the application request pool.

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

## Scripts

```bash
npm install
npm run dev
npm test
npm run test:watch
npm run typecheck
npm run build
```
