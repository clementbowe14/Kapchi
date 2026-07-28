# Kapchi
An online store selling indigenous graduation products and connecting the community through a unified cultural identity.

## Local Development

Backend setup, including local PostgreSQL startup, database creation/reset, and
connectivity checks, is documented in `backend/README.md`.

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
DATABASE_DIRECT_URL=postgresql://...
REDIS_URL=redis://...
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

Configure production PostgreSQL credentials in the deployment platform's
encrypted runtime environment or managed database binding, not in committed
files or the Docker image. On DigitalOcean App Platform, set `DATABASE_URL` and
`DATABASE_DIRECT_URL` on the backend service at runtime. If any real PostgreSQL
URL, username, password, certificate, or token is exposed, rotate or revoke it in
the database provider before redeploying and update only the provider-side
secret value.

GitHub secret scanning with push protection should stay enabled for this
repository. If a custom CI pipeline is added later, include a secret scan such as
Gitleaks or TruffleHog so accidental PostgreSQL credentials are caught before
merge.

Build locally:

```bash
docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_example \
  -t kapchi-fullstack .
```
