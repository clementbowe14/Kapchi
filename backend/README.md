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

Use Node `20.9.0` or newer. This backend runs TypeScript through `tsx`, so `node src/server.ts` will fail with `ERR_UNKNOWN_FILE_EXTENSION`.

Environment variables are loaded from `backend/.env.devel` when present, with `backend/.env` used as a fallback for any missing keys.

```bash
nvm use
npm install
npm run dev
npm run typecheck
npm run build
```

For production-style startup:

```bash
npm run build
npm start
```
