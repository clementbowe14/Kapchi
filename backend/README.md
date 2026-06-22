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
