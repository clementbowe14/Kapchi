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
npm run stripe:catalog:sync:local
```

The seed command loads `backend/.env`, uses `DATABASE_URL`, and is safe to run
more than once. It updates deterministic seed-owned rows instead of creating a
new copy on each run.

The Stripe catalog command is deliberately explicit and is never run during
application startup. It uses the test credential in `backend/.env` to create or
reuse Stripe test Products and Prices for the local seed listings, then replaces
the local placeholder mappings in one database transaction. Run it after every
seed when you need a real hosted Checkout session.

The command refuses to run with `NODE_ENV=production`, a non-local or
non-development database name, a non-local database host, or a Stripe credential
that is not test mode. It verifies the Stripe account first and rejects any
Product or Price returned with `livemode=true`.

## Seeded Records

The local seed currently includes:

- example active listings for a graduation stole and an accessory
- customization sets, font options, trim options, and local Stripe placeholders
  that the explicit catalog sync replaces with real test Product and Price IDs
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

Seed reruns preserve synchronized Stripe IDs only when the stored amount and
currency still match the seed's desired pricing identity. If either value
drifts, the seed atomically restores deterministic `prod_local_seed_*` and
`price_local_seed_*` placeholders on the listing and affected active variant.
This fail-closed state prevents Checkout from charging an obsolete Stripe Price;
run the catalog sync again before retrying Checkout. Retired placeholder rows
are renamed before reuse so the non-null and unique Price columns remain valid.

Stripe Prices are immutable. The sync uses stable Product ownership metadata and
Price lookup keys, but a replacement create also includes the observed
predecessor Price generation in its idempotency key. Stripe Products are mutable,
so their metadata carries a monotonic catalog generation; Product update keys
include both that observed generation and the desired fields. This keeps repeated
A-to-B-to-A-to-B edits from replaying a cached response for an older transition.

The sync commits mappings only if the listing base price/currency, active default
variant identity, and every active variant amount/currency still equal the values
used during remote preparation. Concurrent local pricing drift therefore rolls
the entire mapping transaction back instead of pairing current local prices with
stale remote preparation.

After recovery checks, the same transaction finds explicit predecessor Price IDs
still referenced by sessionless `pending_payment` orders without a durable
`checkout.catalog_unavailable` event. Those Prices remain active and are counted
as `pricesProtected`, separately from `cleanupFailures`. This protects generic
provider failures that the sync must not recover. Once an order becomes terminal,
rerunning the sync retries deactivation. Each new Price stores only its immediate
predecessor in the bounded `kapchi_replaced_price_id` metadata value. Preparation
retrieves and validates that linked history so protection and cleanup still cover
every ancestor without growing one Stripe metadata value past its limit. Existing
`kapchi_replaced_price_ids` metadata is read for compatibility. Invalid, cyclic,
live-mode, or wrong-listing predecessor chains fail before database mappings are
written. Cleanup touches only validated ancestors; a provider cleanup failure is
reported and retried on the next run. Historical `order_items` are never changed.

Only one sync can run at a time. A PostgreSQL session advisory lock is held from
before Stripe preparation through post-commit cleanup; a concurrent command
fails immediately without calling Stripe. Every selected Product and Price is
checked for ownership, expected amount/currency, and `livemode=false` before its
binding is committed.

If a previous checkout failed with only known local placeholders, or runtime
recorded the durable `checkout.catalog_unavailable` order event, the sync can
retire that failed attempt. Recovery still requires a sessionless failed order
containing only local seed listings and a non-expired cart that can become the
owner's active cart. Blocked carts leave their orders untouched. Eligible orders
are cancelled, a privacy-safe `checkout.catalog_mapping_recovered` event is
recorded, and the cart is reactivated. Historical `order_items` are never
rewritten; the next checkout creates a fresh order from the synchronized catalog.

## Safety Guardrails

`npm run db:seed:local` refuses to run when:

- `NODE_ENV=production`
- `DATABASE_URL` is missing or not a PostgreSQL URL
- the database host is not `localhost`, `127.0.0.1`, `::1`, or `0.0.0.0`
- the database name does not include `dev`, `test`, or `local`

Use a database such as `kapchi_local` or `kapchi_test`. Do not point
`DATABASE_URL` at production, a shared staging database, or a remote tunnel to
production data.

`npm run stripe:catalog:sync:local` applies the same database guardrails and also
requires `STRIPE_SECRET_KEY` to begin with `sk_test_` or `rk_test_`. The command
prints only safe account, Product, Price, lookup-key, and result identifiers. It
never prints the Stripe credential or a raw provider/database error message.
Its JSON summary includes `pricesProtected`; a non-zero value is expected while
an unresolved generic checkout attempt still references a replaced Price.

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

When `RUN_DATABASE_INTEGRATION_TESTS=true`, Vitest serializes test files because
the integration fixtures intentionally share deterministic local seed rows.
Ordinary unit-only runs retain parallel file execution.
