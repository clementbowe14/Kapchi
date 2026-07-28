# Kapchi
An online store selling indigenous graduation products and connecting the community through a unified cultural identity.

## Local Development

Backend setup, including local PostgreSQL startup, Redis configuration, database
creation/reset, and connectivity checks, is documented in `backend/README.md`.

## Docker Deployment

The root `Dockerfile` builds the Fastify backend and Next.js frontend into one
Linux AMD64 image for DigitalOcean App Platform.

At runtime, the frontend binds to `0.0.0.0:$PORT`. DigitalOcean App Platform
uses `8080` as the default public HTTP port, so the image defaults `PORT` to
`8080`. The backend runs inside the same container on `BACKEND_PORT`, defaulting
to `4000`, and the frontend proxies `/api/*` requests to it.

Required runtime environment variables:

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...
REDIS_URL=rediss://<redis-user>:<redis-password>@<redis-host>:<redis-port>/<redis-db>
CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
CLERK_JWT_ISSUER=...
CLERK_JWKS_URL=...
CLERK_WEBHOOK_SECRET=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
```

Optional runtime environment variables:

```bash
PORT=8080
BACKEND_PORT=4000
BACKEND_HOST=localhost
BACKEND_INTERNAL_URL=http://localhost:4000
LOG_LEVEL=info
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=10000
DATABASE_IDLE_TIMEOUT_MS=30000
STRIPE_API_VERSION=2026-02-25.clover
```

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is also needed at build time for the Next.js
build. In DigitalOcean App Platform, configure it with build and run scope.

Configure production Redis credentials only through the deployment platform's
environment variable or secret manager. For DigitalOcean App Platform, set
`REDIS_URL` as an encrypted runtime environment variable using the managed Redis
provider connection string; do not commit production Redis URLs, usernames,
passwords, or tokens to this repository. If any production Redis credential is
ever exposed in git, logs, or a shared shell history, rotate or revoke it in the
Redis provider before redeploying the app.

GitHub secret scanning with push protection should stay enabled for this
repository. If a custom CI pipeline is added later, include a secret scan such as
Gitleaks or TruffleHog so accidental Redis credentials are caught before merge.

Build locally:

```bash
docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_example \
  -t kapchi-fullstack .
```
