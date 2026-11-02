# Admin orders E2E setup

The public test runs with a clean browser context:

```bash
npm run test:e2e:public
```

The authenticated projects require a Clerk test-mode admin session saved outside
Git as Playwright storage state. Set `E2E_ADMIN_STORAGE_STATE` to that JSON file
or place it at `client/.auth/admin.json`. The Clerk user must carry the exact
backend `admin` role. Traces, videos, and screenshots are disabled so the
session cannot enter test artifacts.

```bash
npm run test:e2e:admin
```

The real API smoke test requires the same Clerk admin session. Its dedicated
Playwright configuration validates that fixture, seeds the local database, and
starts both Fastify on port 4000 and Next.js on port 3100:

```bash
npm run test:e2e:real
```

`npm run test:e2e` executes the public and mocked authenticated browser projects.
`npm run test:e2e:real` is intentionally separate because it mutates the local
development database. A missing authenticated storage-state file is a failing
prerequisite, not a passing skip.
