# Local Seed Data

Kapchi includes a local-only seed workflow for realistic store data. The command
creates fake catalog, inventory, cart, asset, and order records for development
and admin workflow testing.

## Run The Seed

From the backend workspace:

```bash
cd backend
npm run db:migrate:apply
npm run db:seed:local
```

The seed command loads `backend/.env`, uses `DATABASE_URL`, and is safe to run
more than once. It updates deterministic seed-owned rows instead of creating a
new copy on each run.

## Seeded Records

The local seed currently includes:

- example active listings for a graduation stole and an accessory
- customization sets, font options, trim options, and Stripe test product/price
  identifiers
- fabric inventory for navy and gold satin, with stock/reserved/sold counts
- a converted cart with a customization image asset
- a paid order with an order item, fabric reservation, event, and fake outbound
  order message

The customer-facing lookup fixture is:

```text
Order ID: LOCAL-SEED-1001
Email: local-demo@example.test
Phone: +1555010053
```

All customer/contact values use fake local data and `example.test` addresses.
No real customer information, real provider object URLs, or secrets belong in
the seed fixtures.

## Safety Guardrails

`npm run db:seed:local` refuses to run when:

- `NODE_ENV=production`
- `DATABASE_URL` is missing or not a PostgreSQL URL
- the database host is not `localhost`, `127.0.0.1`, `::1`, or `0.0.0.0`
- the database name does not include `dev`, `test`, or `local`

Use a database such as `kapchi_local` or `kapchi_test`. Do not point
`DATABASE_URL` at production, a shared staging database, or a remote tunnel to
production data.

## Reuse In Tests

Automated tests can import deterministic fixture metadata from
`src/database/seed.ts`:

```ts
import {
  localSeedFixtures,
  seedFabrics,
  seedListings
} from "../database/seed.js";
```

Use those exports when tests need stable seed slugs, SKUs, public order numbers,
or fake contact details. Tests that need isolated data should still create rows
inside their own transaction or test database.
