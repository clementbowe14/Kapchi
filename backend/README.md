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

The backend uses one database client factory with two connection modes.

For local development, connect to a local PostgreSQL instance with a standard
connection string:

```bash
DATABASE_MODE=local-postgres
DATABASE_URL=postgresql://kapchi:password@localhost:5432/kapchi_dev
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=10000
DATABASE_IDLE_TIMEOUT_MS=30000
```

For staging and production, connect to Aurora DSQL with IAM-authenticated
PostgreSQL connections:

```bash
DATABASE_MODE=aurora-dsql
AWS_REGION=us-east-1
DSQL_HOST=your-cluster-id.dsql.us-east-1.on.aws
DSQL_DATABASE=postgres
DSQL_USER=kapchi_app
DSQL_AUTH_MODE=custom
DSQL_TOKEN_EXPIRES_IN_SECONDS=3600
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=10000
DATABASE_IDLE_TIMEOUT_MS=30000
```

`DSQL_AUTH_MODE=admin` uses the admin IAM auth token path. Use
`DSQL_AUTH_MODE=custom` for a custom database role with `dsql:DbConnect`
permissions. The AWS SDK credential provider chain resolves IAM credentials at
runtime, so production should use the deployment role rather than committed
static credentials.
