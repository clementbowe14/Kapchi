# Local Fixture Data

Kapchi provides deterministic, provider-safe fixture data for local development,
admin workflow review, analytics reconciliation, and database integration tests.
The fixture commands refuse to use an unmarked database.

## First-Time Setup

Use a fresh local database whose name contains `local`, `dev`, or `test`. Existing
rows from the legacy seed are not adopted because their ownership cannot be
proven. Reset or create a separate local database before initialization.

From `backend`:

```bash
npm run db:migrate:apply
npm run db:fixtures:init -- --confirm-database kapchi_local
```

The initialization command prints `KAPCHI_FIXTURE_DATABASE_TOKEN` once. Add that
value to `backend/.env`, then run:

```bash
npm run db:seed:local
npm run db:seed:verify
```

The initializer creates a private `kapchi_fixture` schema only in that database.
It binds the token to the database name and OID and records fixture row ownership,
optional admin bindings, and verified Stripe test-catalog attestations. This schema
is local tooling and is never created by production migrations.

Both seed and verification also require `NODE_ENV=development` or `test`, a
loopback PostgreSQL host, and a local/test-looking database name. Missing or
mismatched markers, tokens, names, OIDs, or hosts fail closed.

## Seeded Workflows

The fixture set includes:

- two active listings, all customization levels, fonts, trims, production rules,
  public catalog assets, and shared navy/gold fabrics;
- an active cart hold and a converted cart/order reservation;
- six fake identities and contacts using `example.test` and `+1-202-555-01xx`;
- 13 orders covering unpaid, paid queue, production, ready, partial shipment,
  delivery, cancellation, partial/full/failed/manual-review refunds, missing
  production data, and non-USD analytics exclusion;
- fulfillment and shipment quantities, fake `TEST_CARRIER` tracking, and terminal
  shipping export history marked `DO NOT SHIP - TEST FIXTURE`;
- private artwork metadata using the unsupported `fixture_unsupported` provider;
- awaiting-admin, awaiting-customer, and resolved conversations, an internal note,
  terminal message jobs, and terminal notification intents;
- terminal/inert refund operations and processed/exhausted webhook evidence.

The stable customer lookup fixture remains:

```text
Order: LOCAL-SEED-1001
Email: returning@example.test
Phone: +1-202-555-0101
```

No fixture has a Stripe Checkout Session. No policy assertion is fabricated while
the active policy bundle is draft. Promotions and unavailable analytics fields are
not simulated.

## Safe Reruns

`db:seed:local` acquires a PostgreSQL advisory lock and runs in one transaction.
Mutable fixture rows return to canonical state; insert-once evidence must retain
its fingerprint. A deterministic ID or business key owned by another row fails
with `FIXTURE_OWNERSHIP_COLLISION`.

If local admin actions create unowned history under a fixture cart, order, user,
message, refund, shipment, or export, reseeding fails with `FIXTURE_GRAPH_DIRTY`.
Recreate the disposable fixture database instead of deleting evidence selectively.

`db:seed:verify` is read-only. It checks ownership, totals, currencies, quantities,
inventory availability, repository-level analytics, refund balances, terminal
provider state, and zero worker eligibility. Output contains only counts, fixture
keys, and bounded invariant codes.

## Local Admin Binding

The committed admin subject is synthetic. To use a real Clerk test user for local
admin mutations, first assign that Clerk user the exact verified `admin` role,
then run:

```bash
npm run db:fixtures:bind-admin -- --subject user_your_test_clerk_subject
```

The subject is not logged. Binding updates the user and fixture ownership hashes
atomically, so reseeding preserves it. Restore the synthetic subject with:

```bash
npm run db:fixtures:unbind-admin
```

## Stripe Test Catalog

Fixture listings initially use inert `prod_local_seed_*` and
`price_local_seed_*` placeholders. Hosted Checkout requires an explicit test sync:

```bash
npm run stripe:catalog:sync:local
```

The command requires the fixture marker/token and an `sk_test_` or `rk_test_`
credential. Stripe resources must report `livemode=false`. Successful mappings
are attested locally with the verified account, exact IDs, fixture ownership, and
pricing fingerprint. The seed preserves only matching attestations; unattested,
altered, live-mode, or price-drifted mappings return to placeholders without
provider I/O. The read-only verifier reports mismatches but never repairs them.

## Tests

Unit tests import stable values from `src/database/seed.ts` and
`src/database/fixtures/admin-workflows.ts`. Database tests are opt-in:

```bash
RUN_DATABASE_INTEGRATION_TESTS=true npm test
```

Use a separate disposable database for integration tests. Vitest serializes test
files when database tests are enabled.
