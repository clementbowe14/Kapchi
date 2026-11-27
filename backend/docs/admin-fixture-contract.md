# Admin Fixture Contract

This document maps issue #85 fixture keys to implemented admin workflows. Run
`npm run db:seed:verify` before using the walkthrough. All routes still require a
verified Clerk token with the exact `admin` role; fixtures never bypass auth.

## Overview Analytics

Query `GET /admin/analytics/sales` for USD, `2026-10-01` through `2026-10-31`,
UTC, daily buckets. Expected supported metrics are:

| Metric | Value |
| --- | ---: |
| Gross sales | 43,700 minor units |
| Discounts | 500 minor units |
| Successful ledger refunds | 5,195 minor units |
| Net sales | 38,005 minor units |
| Paid orders | 10 |
| Average order value | 4,320 minor units |
| Units sold | 11 |
| New resolved customers | 4 |
| Returning resolved customers | 1 |
| Unidentified paid orders | 0 |

Best sellers are Classic Graduation Stole (36,500 / 7 units), then Gold Honor
Cord (7,200 / 4 units). The EUR order is excluded. Refunds include the 2,500
partial refund and the 2,695 full refund, including its 895 shipping charge.
Failed and pending refund operations do not reduce net sales.

The ten paid orders represent five distinct resolved identities. The guest
records in this fixture are explicitly seeded with customer IDs. Ordinary
unclaimed guest checkout has no such ID and is reported as unidentified.

## Orders

Use `GET /admin/orders` and `GET /admin/orders/:orderId` with these public order
numbers:

- `LOCAL-SEED-1001`: paid/queued returning customer and converted cart;
- `FIXTURE-1003`: in production with artwork and production snapshots;
- `FIXTURE-1004`: ready to ship with a label-pending shipment;
- `FIXTURE-1005`: partially shipped quantity coverage;
- `FIXTURE-1006`: delivered/completed;
- `FIXTURE-1007`: partially refunded;
- `FIXTURE-1008`: fully refunded and cancelled;
- `FIXTURE-1009`: failed refund attempt;
- `FIXTURE-1010`: explicitly missing optional production data;
- `FIXTURE-1011`: paid cancellation with terminal notification evidence;
- `FIXTURE-EUR-1`: non-USD analytics isolation.

Existing admin route tests cover 401/403 responses, pagination, validation,
idempotency, and stale lifecycle revisions. Use normal mutation endpoints only
when intentionally testing state changes; a later seed will report
`FIXTURE_GRAPH_DIRTY` if those mutations add unowned evidence.

## Inventory And Shipping

Navy and gold fabrics are shared catalog pools. Navy has one active cart hold;
the converted order has a distinct converted reservation. The verifier checks the
`fabric_inventory_availability` view.

All addresses begin `DO NOT SHIP - TEST FIXTURE`. Tracking uses `TEST_CARRIER`
and `example.test`. Export history is either cancelled with a future expiry or
already expired/purged. There is no active export membership, label purchase, or
purge-eligible fixture batch.

## Messages And Notifications

The fixture set includes awaiting-admin, awaiting-customer, and resolved
conversations. It contains a customer inbound message, admin reply, internal note,
terminal failed delivery, cancellation notice, delivery failure, and refund
notice. Customer-facing reads must not expose the internal note.

All delivery jobs and notification intents are terminal. Lifecycle reconciliation
and materialization workers find zero fixture work.

## Refunds And Webhooks

Persisted states cover successful partial/full refunds, a failed provider attempt,
and an inert `manual_review_required` unknown outcome. The operation read path
returns manual-review records without contacting Stripe. `db:seed:verify` and
repository tests inspect balances without provider I/O.

The live refund summary endpoint is not part of this offline walkthrough because
it intentionally reconciles with Stripe. Stripe webhook fixtures are verified
test-mode evidence in `processed` or `exhausted` state; messaging webhook fixtures
are `processed` or `rejected`. No webhook is replay-eligible.

## Private Artwork

Artwork metadata uses provider `fixture_unsupported`. The metadata route can be
reviewed, but content always returns bounded `ASSET_PROVIDER_UNSUPPORTED`, even
when real Blob credentials are configured. Content tests inject a fake reader;
the fixture never claims a Blob object exists.

## Unsupported Capabilities

- Promotions remain unimplemented under issue #102; no promotion rows exist.
- Policy checkout evidence is absent while the policy bundle is draft; fixture
  orders have no Stripe Checkout Session IDs.
- Ordinary unclaimed guest orders do not have a durable customer identity.
- There is no production `/admin/demo` route.
