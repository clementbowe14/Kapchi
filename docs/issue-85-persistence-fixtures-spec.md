# Issue 85: Safe Persistence and Admin Workflow Fixtures

Status: Approved by three independent reviewers on 2026-11-05

## Objective

Expand Kapchi's local seed data into deterministic fixtures for the persistence models and admin workflows that are implemented on `main`. The fixtures must support local development, database integration tests, and a documented admin API walkthrough while remaining impossible to run against an unmarked database or to turn into live provider work.

This increment covers users and contacts, orders and analytics, production snapshots, inventory reservations, fulfillment and shipping, messaging, notification evidence, refunds, and webhook evidence. It does not fabricate promotions, unavailable analytics fields, a production `/admin/demo`, policy consent to an unapproved bundle, provider-backed artwork bytes, or live delivery/payment/label operations.

## Current Capability Boundary

Implemented and in scope:

- users, customers, customer contacts, and an optional local admin-subject binding;
- admin order search, detail, history, and guarded lifecycle mutations;
- order items and immutable listing, fabric, customization, and production snapshots;
- fabric inventory, an active cart hold, and converted order reservations;
- fulfillments, fulfillment items, shipments, shipment items, and shipping export history;
- conversations, inbound/outbound messages, internal notes, terminal delivery jobs, and terminal transactional notification intents;
- payment reconciliation, successful, failed, and manual-review pending refunds, refund effects, and webhook evidence;
- the currently implemented single-currency sales analytics contract.

Explicitly unsupported in this increment:

- promotions, eligibility, schedules, and redemptions, which remain owned by issue #102;
- analytics net sales, successful refund totals, previous-period comparison output, and new/returning customer output, which the current API does not expose;
- a production `/admin/demo` backend;
- real provider-backed artwork content;
- policy assertion fixtures while there is no approved archived policy bundle;
- live Stripe, Vercel Blob, email, SMS, carrier, or label behavior.

## Safety Boundary

### Explicit fixture database initialization

Add `npm run db:fixtures:init` as a one-time, local-only command. It must:

1. require `NODE_ENV` to be `development` or `test`;
2. require a loopback host or Unix-domain socket and a database name containing `local`, `dev`, or `test`;
3. require the operator to pass the exact current database name through `--confirm-database`;
4. create a private `kapchi_fixture` schema that is not part of normal production migrations;
5. create a singleton `kapchi_fixture.database_guard` row bound to the current database OID, database name, and a hash of a randomly generated local token;
6. create `kapchi_fixture.owned_rows` for fixture key, table name, row ID, natural-key hash, immutable flag, and canonical fingerprint;
7. create `kapchi_fixture.admin_bindings` for the optional local Clerk subject binding hash;
8. create `kapchi_fixture.catalog_attestations` for verified Stripe test-account catalog mappings;
9. return the token once without writing it to repository files or logs.

`db:seed:local`, `db:seed:verify`, and `db:fixtures:bind-admin` require `KAPCHI_FIXTURE_DATABASE_TOKEN`. Each command hashes the token and verifies the in-database marker, current database OID, and current database name before reading or writing fixture data. A missing schema, missing token, mismatch, remote host, production environment, unsafe name, or OID mismatch fails closed with a bounded error code.

Every seed transaction acquires a transaction-scoped PostgreSQL advisory lock derived from the database OID and the fixture namespace. A second seed waits for the first and then revalidates ownership and fingerprints. Tests cover concurrent invocations.

The initialization schema is local tooling, not a production migration. Database tests create it in a disposable test database and drop the entire database after the suite. Shared staging and production databases must never be initialized for fixtures.

### Ownership and collision rules

A fixture row may be inserted only after its deterministic primary key and natural unique keys have been checked. If a matching business row exists without a matching `kapchi_fixture.owned_rows` record, seeding aborts with `FIXTURE_OWNERSHIP_COLLISION`; the seed never adopts or overwrites it automatically.

Legacy seed rows are never adopted automatically because the previous seed did not record enough ownership evidence to distinguish fixtures from developer-created data. Initialization and seeding fail on collisions. Developers must use a fresh or reset disposable local database when moving to the guarded fixture workflow.

The seed never performs broad deletion. Removed fixture keys are reported as `FIXTURE_RETIRED_ROW_PRESENT`; developers recreate the disposable fixture database instead of deleting evidence. Non-fixture rows are never selected by fixture cleanup or mutation.

### Table-by-table write policy

Mutable canonical upserts, after ownership verification:

- `listings`, `listing_images`, and `listing_customization_sets`;
- `font_options`, `listing_customization_fonts`, `trim_options`, and `listing_customization_trims`;
- `listing_price_variants`, `fabrics`, `listing_fabrics`, and public catalog `assets`;
- `users`, `customers`, `customer_contacts`;
- `carts`, `cart_items`, `assets`, `fabric_reservations`;
- `orders`, `order_items`, `order_fulfillments`, `order_fulfillment_items`;
- `shipments`, `shipment_items`, `order_conversations`;
- `payment_reconciliation_state`.

These rows are restored to canonical fixture state on rerun. Child rows are upserted before any parent field that exposes them as active. No referenced row is deleted.

Insert-once evidence, with exact fingerprint comparison and drift failure:

- `order_events`, `admin_audit_events`, `admin_order_mutation_receipts`;
- `listing_production_estimate_rules`, whose revisions are immutable;
- `fabric_inventory_events`;
- `shipping_export_batches`, `shipping_export_batch_items`, `shipping_export_mutation_receipts`;
- `order_messages`, `message_delivery_jobs`, `messaging_webhook_events`;
- `transactional_notification_intents`;
- `refund_operations`, `refund_effects`, `stripe_webhook_events`;
- `order_policy_assertions` when an approved policy fixture is added in a later increment.

`shipping_export_active_memberships` is not seeded because it represents active operational work. Seeded export batches are terminal `cancelled` or `expired` history with no active membership and no shipment pointer to an active batch.

For all insert-once rows, an existing row with the fixture key must have the expected ownership record and fingerprint. The seed neither updates nor deletes evidence. Database-generated maintenance timestamps are excluded from fingerprints only where the table's semantics permit them to change.

The existing catalog seed is fully moved behind this policy. Its image deletion, obsolete-variant deactivation, and other broad catalog mutations are removed. Catalog rows use ownership-checked canonical upserts, while production estimate revisions are insert-once. A catalog ID, slug, SKU, provider/storage key, option name, variant key, or link key owned by someone else is a collision, not an adoption opportunity.

`customization_sets` is migration-owned reference data, not fixture-owned data. Before acquiring or writing any fixture business row, the seed validates that every required customization kind exists once and that its migration-defined kind and required semantics match the application contract. It reads and references those IDs but never updates or registers them in `owned_rows`. Missing, duplicated, or changed baseline definitions fail with `FIXTURE_DEPENDENCY_DRIFT`; a freshly migrated database requires no adoption.

Stripe test catalog synchronization is a sanctioned external mutation of fixture-owned listings and price variants, but Product and Price ID strings do not reveal whether they came from test or live mode. The `stripe:catalog:sync:local` command therefore joins the fixture trust boundary: before Stripe I/O it verifies the fixture marker/token, row ownership, and canonical pricing identity, then acquires the same fixture advisory lock used by seeding. It verifies the returned Product and Price objects have `livemode=false` and records the Stripe account ID, exact Product/Price IDs, fixture keys, ownership metadata, and canonical pricing-identity fingerprint in `kapchi_fixture.catalog_attestations` in the same database transaction that updates the catalog mappings.

Actual `stripe_product_id`, `stripe_price_id`, and default price mappings are excluded from canonical restoration and ordinary fingerprints only when an attestation exactly matches the current database marker, fixture ownership, account, IDs, listing/variant key, customization kind, amount, currency, and active relationship. For missing, live-mode, altered, or mismatched attestations, the guarded seed transaction restores reviewed local placeholders and invalidates the attestation without contacting Stripe. A pricing-identity drift does the same. The read-only verifier never repairs data; it exits nonzero with a bounded catalog-attestation invariant code and leaves the database unchanged.

Before restoring any mutable fixture row, the seed scans every foreign-key dependent table in the fixture graph. If an unowned event, receipt, shipment, export row, message, notification intent, audit record, refund row, asset access event, reservation, or other child references a fixture-owned parent, the transaction aborts with `FIXTURE_GRAPH_DIRTY` and instructs the developer to recreate the disposable fixture database. This prevents canonical parent restoration from contradicting locally created history.

## Fixture Catalog

Create `backend/src/database/fixtures/admin-workflows.ts` as the typed source for deterministic fixture IDs, business timestamps, expected relationships, and independently reviewed analytics constants. Provider identifiers use test-only prefixes such as `pi_test_fixture_*`, `re_test_fixture_*`, and `evt_test_fixture_*`. No fixture order has a Stripe Checkout Session ID.

Use these reporting windows:

- previous: `2026-09-01T00:00:00.000Z` inclusive through `2026-10-01T00:00:00.000Z` exclusive;
- current: `2026-10-01T00:00:00.000Z` inclusive through `2026-11-01T00:00:00.000Z` exclusive.

Active cart reservations use a deterministic `2099-01-01T00:00:00.000Z` expiry. Reporting timestamps remain fixed. Integration tests use a clock before that expiry and assert both cart access and the `fabric_inventory_availability` view.

The catalog contains fixture inputs, but analytics expected results live in a separate reviewed constant object and are not computed from insertion objects at runtime. Tests call `SalesAnalyticsRepository.getSalesReport` and compare exact USD summary values, bucket values, best-seller ordering, and breakdowns to those constants.

## Identity and Authentication Fixtures

Seed deterministic fake identities for:

- one read-only fixture admin record with `auth_provider='clerk'` and a non-real subject;
- one returning authenticated customer with purchases in both reporting periods;
- one new authenticated customer first purchasing in the current period;
- one guest customer;
- one SMS-preferred customer;
- one customer missing optional contact data.

All committed contacts use `example.test`. Phone numbers use the reserved North American fictional range `+1-202-555-01xx`. `accepts_marketing` is always false.

The deterministic admin cannot impersonate a developer. `kapchi_fixture.admin_bindings` stores the fixture admin user ID and the bound subject hash. `npm run db:fixtures:bind-admin -- --subject <verified-clerk-subject>` atomically checks that no other user owns the provider/subject pair, updates only the fixture-owned admin user, and records the new hash. It requires the database token and never logs the subject. Reseeding preserves `auth_subject` only when the binding row, current subject hash, user ownership, and uniqueness checks all agree; otherwise it fails closed. `db:fixtures:unbind-admin` atomically removes the binding and restores the deterministic fake subject. Tests cover bind, reseed, `resolveActor`, collision rejection, and unbind.

The developer must separately configure the Clerk test user with the exact verified `admin` role; the backend continues to derive roles and capabilities only from the verified JWT. Integration tests use the existing injected test-auth harness rather than a real Clerk token.

## Orders, Analytics, and Lifecycle Matrix

Create a compact set of orders covering unpaid, paid/queued, in production, ready to ship, shipped, delivered/completed, cancelled, partially refunded, fully refunded, failed refund, missing production data, archived-product snapshot, and a non-USD exclusion case.

The canonical mappings are:

| Scenario | `orders.status` | `payment_status` | top-level `fulfillment_status` | fulfillment row | shipment row |
| --- | --- | --- | --- | --- | --- |
| Unpaid | `pending_payment` | `unpaid` | `not_started` | none | none |
| Paid queue | `paid` | `paid` | `queued` | `queued` | none |
| In production | `in_production` | `paid` | `in_progress` | `in_progress` | none |
| Ready | `ready_to_ship` | `paid` | `ready_to_ship` | `ready_to_ship` | `label_pending` |
| Partial shipment | `shipped` | `paid` | `shipped` | `partially_shipped` plus `shipped` as needed | `in_transit` |
| Delivered | `completed` | `paid` | `delivered` | `completed` | `completed` |
| Cancelled | `cancelled` | supported paid or refunded state | `cancelled` | `cancelled` when present | none or `voided` |
| Partial refund | supported lifecycle state | `partially_refunded` | matching lifecycle state | optional | optional |
| Full refund | supported lifecycle state | `refunded` | matching lifecycle state | optional | optional |

Refund completion changes `payment_status`; it does not invent an `orders.status='refunded'` transition. Timestamps required by each state must be present and monotonic.

For every order item:

- `total_amount_cents = unit_amount_cents * quantity`;
- order currency equals included item currency;
- `total_cents = subtotal_cents + shipping_cents + tax_cents - discount_cents`;
- total fulfillment quantity per order item never exceeds ordered quantity;
- total shipment quantity per order item never exceeds fulfilled and ordered quantity;
- completed fulfillment and shipment scenarios allocate the full ordered quantity;
- partial shipment scenarios allocate a strict positive subset and retain the remainder in another valid fulfillment state.

Analytics assertions use the repository's real cohort semantics: `orders.created_at`, the requested currency, and paid statuses `paid`, `partially_refunded`, and `refunded`. They verify USD isolation, item-currency filtering, daily buckets, deterministic best-seller tie ordering, all payment/fulfillment breakdown entries, and null `netSalesMinor`/`successfulRefundsMinor` plus the current unavailable capability metadata.

## Production, Artwork, and Inventory

At least two order items include immutable listing, fabric, customization, and production estimate snapshots. One references a private synthetic artwork metadata row whose provider is `fixture_unsupported`; no blob bytes are claimed to exist. The provider-neutral metadata route works, while the content route always fails with bounded `ASSET_PROVIDER_UNSUPPORTED`, even when real Vercel Blob credentials are configured. Unit and integration tests may inject a reader for `fixture_unsupported` with synthetic bytes only when content-delivery behavior is intentionally exercised.

Another order intentionally lacks optional artwork or production data so the real missing-data state remains testable.

Shared fabric pools cover multiple listings. One active cart hold expires in 2099 and one converted order reservation is historical. The verifier checks on-hand, active reserved, sold/converted, and available quantities against `fabric_inventory_availability`.

## Fulfillment and Shipping

Addresses use an example recipient, reserved phone number, and line 1 beginning `DO NOT SHIP - TEST FIXTURE`. Carrier is `TEST_CARRIER`, tracking URLs use `https://example.test/tracking/...`, and no label URL or provider shipment ID is live-shaped.

Ready, partial, in-transit, and delivered examples follow the lifecycle and quantity matrix. Shipping export evidence uses exact terminal shapes: a cancelled batch has a 2099 expiry, fixed `cancelled_at`, and a retained `DO NOT SHIP - TEST FIXTURE` row snapshot; an expired batch has fixed `purged_at` and `row_snapshot=null`. Neither has an active membership or active shipment pointer. The seed does not create an exportable file on disk, and `purgeExpired` must report zero fixture work.

## Refund and Webhook Invariants

All payment reconciliation and refund rows have `livemode=false`. For each order:

- `captured = succeeded + pending + remaining_refundable`;
- `provider_refunded_amount_cents = sum(succeeded provider refunds)` when reconciliation is `current`;
- `payment_status='partially_refunded'` when `0 < succeeded < captured`;
- `payment_status='refunded'` when `succeeded >= captured`;
- failed operations reserve no balance;
- pending manual-review operations reserve their amount and may produce an overcommit warning only in the explicit conflict fixture.

The pending/unknown-outcome fixture is deliberately inert: `pending_reason='unknown_outcome'`, `manual_review_required=true`, no dispatch lease, no reconciliation lease, `next_reconciliation_at=null`, and `dispatch_ever_claimed=true` so it cannot be claimed as a new reserved dispatch. The operation read path must not invoke provider recovery for manual-review operations; current service behavior does, so this increment adds that narrow early return and tests it with a fail-fast provider double.

Refund effects are `not_requested`, `unsupported`, `succeeded`, or terminal `failed`; none is pending. Notification effects that are represented as succeeded have a linked terminal notification intent.

Stripe webhook events are only `processed` or `exhausted`, with `livemode=false`, `livemode_verified=true`, null lease fields, and `next_attempt_at=null`. Processed rows have `processed_at`; exhausted rows have terminal attempt counts, `manual_review_required=true`, a bounded error code, no raw payload, and a scrubbed projection. Messaging webhook events are only `processed` or `rejected`. Payload projections contain fake IDs and no contacts, secrets, or raw provider errors.

The verifier and integration suite prove:

- `claimDispatch` cannot claim any fixture refund;
- `claimRecoveryCandidates` returns no fixture refund;
- refund-effect promotion finds no fixture effect;
- webhook inbox replay claims no fixture event;
- notification lifecycle reconciliation creates zero intents;
- notification materialization claims no fixture intent;
- message dispatch claims no fixture delivery job.
- shipping export `purgeExpired` reports zero fixture batches.

Provider adapters in these tests throw immediately if invoked.

## Messaging and Notification Evidence

Seed conversations in `awaiting_admin`, `awaiting_customer`, and `resolved` states. Include one inbound customer message, one sent admin reply, one internal note, and one terminal failed outbound message with a bounded fake error code. Internal notes are asserted absent from customer-facing reads.

Every cancelled paid order and every delivered/completed shipment that matches notification reconciliation has the exact terminal intent idempotency key expected by the producer queries. Intents are only `succeeded` or terminal `failed`; delivery jobs are only `succeeded` or `failed`. Lease fields are null and retry times are inert. Running reconciliation after either the first or second seed creates zero rows.

## Policy Evidence

The repository currently contains only policy bundle `2026-11-03.1`, and it is draft. The fixture system must not fabricate customer agreement to it. Therefore:

- every fixture order has `stripe_checkout_session_id=null`;
- no fixture `order_policy_assertions` row is inserted in this increment;
- the verifier asserts that no fixture order is session-bearing;
- documentation labels policy checkout evidence unsupported until an owner-approved archived bundle exists.

When a future approved archive is available, a new versioned fixture key may insert an assertion pinned to that exact immutable archive. It must never follow `policies/active.json`, and a future active-version change must not rewrite old evidence. Admin labeling of historical policy state is not claimed because the current admin contract does not expose it.

## Seed and Verification Commands

Keep `npm run db:seed:local` as the seed command and add read-only `npm run db:seed:verify`. Both share the guard and ownership library.

The seed runs in one transaction after acquiring the advisory lock. Failures roll back all business rows and ownership records created in that run. Logs contain only a bounded event name, invariant/error code, fixture key, table alias, and request/run ID. They must not include SQL, contact fields, message bodies, addresses, filenames, payloads, provider errors, or the database token.

The verifier returns a bounded JSON summary containing counts, fixture keys, invariant codes, and reviewed analytics constants. It checks ownership, relationships, totals, currencies, lifecycle quantities, inventory availability, refund equations, worker-zero guarantees, terminal webhook/message state, session/policy absence, and unsupported capability absence.

## Backend Acceptance Walkthrough

Create `backend/docs/admin-fixture-contract.md` mapping fixture keys to implemented workflows:

- Overview: exact current-period USD analytics constants and explicit unavailable fields;
- Orders: search, filters, pagination, detail snapshots, missing production data, and stale revision tests;
- Inventory: shared pools, active and converted reservations, and availability totals;
- Messages: conversation states, internal-note privacy, delivery failure, and missing contact;
- Refunds: persisted partial, full, failed, and inert manual-review states inspected by `db:seed:verify` and repository tests; the live summary endpoint is excluded because it intentionally reconciles with Stripe;
- Shipping: ready-to-ship display, terminal export history, tracking, and completed history;
- Assets: metadata success and expected provider-unavailable content without a fake reader;
- Promotions and policy checkout evidence: explicitly unsupported.

The walkthrough references existing automated 401, 403, pagination, validation, idempotency, stale-revision, and provider-unavailable tests. It does not invoke the provider-reconciling refund summary route, weaken authentication, or add a production demo route. Tests run with provider credentials present and fail-fast provider doubles to prove every documented fixture path makes zero provider calls.

## Tests

### Unit tests

- fixture ID/natural-key uniqueness and independent analytics constants;
- reserved domains, phones, addresses, provider prefixes, currencies, and timestamps;
- guard rejection for production, remote hosts, unsafe names, absent/mismatched marker, OID mismatch, and token mismatch;
- ownership collision tests for IDs, slug/SKU, provider IDs, and idempotency keys;
- freshly migrated customization definitions pass without adoption, while baseline drift fails before fixture writes;
- valid attested Stripe test catalog mappings survive reseeding, while absent, mismatched, live-mode, manually inserted, or pricing-drifted mappings reset to placeholders without provider I/O;
- the read-only verifier reports catalog-attestation failures without changing mappings or attestations;
- dirty fixture graph detection for unowned dependent rows;
- immutable fingerprint drift and redacted error output;
- lifecycle, quantity, totals, refund equations, and no-session policy rules.

### Database integration tests

- create and initialize a disposable test database, migrate, seed, verify, and drop it in teardown even after failure;
- seed twice and compare canonical fingerprints and counts;
- run two seed processes and prove the transaction advisory lock serializes them;
- preserve an unrelated sentinel row unchanged;
- reject an unregistered deterministic ID or natural-key collision;
- restore mutable fixture drift and reject insert-once evidence drift;
- query `fabric_inventory_availability` and assert the 2099 hold is active;
- call `SalesAnalyticsRepository` and compare explicit USD constants, buckets, best sellers, breakdowns, isolation, and null unsupported metrics;
- verify lifecycle/quantity reconciliation and refund equations;
- run every worker eligibility/claim path and prove zero fixture work and zero provider calls;
- run notification reconciliation twice and prove zero rows are created;
- verify metadata-only artwork behavior through a fake reader and provider-unavailable behavior without one;
- verify fixture admin binding changes only the owned admin subject and real auth still requires verified JWT role claims;
- verify bind, reseed, `resolveActor`, collision rejection, and unbind while preserving ownership metadata;
- run shipping export purge and prove zero fixture work;
- configure real-shaped provider credentials while fail-fast adapters prove all fixture walkthroughs remain offline.

### Existing suites

Run backend unit tests, typecheck, build, and focused admin orders, analytics, inventory, messaging, notifications, refunds, shipping, assets, policy, and authorization suites.

## Delivery Slices

Each slice includes its fixture catalog entries, ownership records, verifier checks, integration tests, and documentation. Slices may be separate commits or PRs, but no slice may bypass the shared database guard.

1. **Fixture safety plus identities/orders/analytics:** initialization marker, token binding, ownership registry, advisory lock, fake identities, admin binding, base orders/items, independent analytics constants, and verifier foundation.
2. **Production/inventory/fulfillment/shipping:** snapshots, metadata-only artwork, active/converted fabric reservations, lifecycle matrix, shipment quantities, and terminal export history.
3. **Messaging/notifications:** conversation states, messages, internal notes, terminal jobs/intents, missing-contact behavior, and reconciliation-zero tests.
4. **Refunds/webhooks/policy boundary:** payment reconciliation, successful/failed/manual-review refunds, terminal effects/webhooks, manual-review read guard if required, all worker-zero tests, and explicit no-session/no-policy-evidence assertions.

Two implementation agents may work after approval with disjoint write ownership:

- Agent A: slices 1 and 2, including fixture infrastructure, base verifier, identities/orders/analytics, production, inventory, fulfillment, and shipping.
- Agent B: slices 3 and 4, including messaging, notifications, refunds, webhooks, policy boundary, and the narrow manual-review runtime guard if needed.

The lead agent integrates documentation and runs the complete cross-slice verification suite.

## Definition of Done

- All currently supported issue #85 fixtures are deterministic, fake, database-owned, idempotent, and guarded by an explicit fixture marker and token.
- Two consecutive and two concurrent seed runs preserve canonical state and unrelated rows.
- No fixture row is eligible for provider, worker, delivery, refund, webhook, or export execution.
- Exact analytics constants and all lifecycle, quantity, inventory, currency, and refund invariants pass through repository-level integration tests.
- The verifier emits only bounded, redacted output.
- Backend tests, typecheck, build, and focused database integration suites pass.
- Documentation identifies unsupported promotions, policy evidence, provider-backed artwork, and analytics fields without pretending they are complete.
- Issue #85 remains open only for future increments tied to capabilities that are still genuinely unavailable.
