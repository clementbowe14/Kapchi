# Backend

This backend workspace currently includes:

- centralized environment configuration
- Fastify bootstrap
- security/runtime plugins
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

## Scripts

```bash
npm install
npm run dev
npm run db:migrate:create -- add_example_change
npm run db:migrate:apply
npm run db:migrate:status
npm run db:migrate:history
npm run db:migrate:reset -- --force
npm test
npm run test:watch
npm run typecheck
npm run build
```

## Database Configuration

The backend connects to PostgreSQL with a standard connection string. Use a
local Postgres URL in development and the managed database URL provided by the
hosting platform in staging and production.

```bash
DATABASE_URL=postgresql://kapchi:password@localhost:5432/kapchi_dev
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=10000
DATABASE_IDLE_TIMEOUT_MS=30000
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
