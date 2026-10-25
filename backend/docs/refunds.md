# Refund ledger and reconciliation

Kapchi records every Stripe refund in PostgreSQL before treating it as an
order balance change. Stripe is authoritative for captured and refunded
amounts; the ledger is the durable operational and audit record.

## Authorization

Refund routes require the `orders:refund` permission and an active local
`users` row matching the verified Clerk subject. Never accept an actor ID,
payment identifier, captured amount, or available balance from the client.

## API

- `GET /admin/orders/:orderId/refunds/summary` reconciles Stripe before
  returning captured, successful, pending, and remaining amounts.
- `POST /admin/orders/:orderId/refunds` requires `Idempotency-Key`. Omit
  `amountCents` to refund the latest full remaining balance.
- `GET /admin/refunds/:operationId` recovers the durable operation status.

All monetary values are integer minor units. Pending reasons make recovery
explicit: `reserved`, `provider_pending`, `requires_action`,
`unknown_outcome`, and `provider_conflict`.

## Worker

Run this command from a scheduler at least once per minute:

```sh
npm run refunds:reconcile
```

The worker uses PostgreSQL leases and `FOR UPDATE SKIP LOCKED`, so overlapping
runs are safe. Monitor completion, oldest pending age, retry exhaustion,
unmatched webhooks, and `provider_conflict` operations.

## Ambiguous outcomes

Never mark an operation failed merely because a request timed out. Never issue
a replacement refund while the original outcome is unknown. Reconciliation
may retrieve Stripe state at any age, but an operation older than 23 hours is
not automatically sent to `refunds.create` because Stripe can eventually prune
idempotency records.

Provider responses are accepted only when their payment intent, amount,
currency, live/test mode, and any returned operation/order metadata match the
persisted reservation. A mismatch remains reserved, is marked
`provider_conflict`, and requires manual review; it is never counted as a
successful refund.

Manual review compares the operation UUID, PaymentIntent, amount, currency,
Stripe account/mode, provider refund metadata, and Dashboard state. Resolving
an ambiguity requires immutable evidence and `orders:refund:resolve`. A
replacement financial request uses new keys only after the old operation is
definitively resolved.

## Webhooks

The verified webhook endpoint commits a minimal typed projection before domain
processing. It does not retain raw provider bodies. Duplicate events are safe.
Processing failure is retried internally after durable receipt. A non-2xx
response means Kapchi could not durably record the verified event.

## Allocation and effects

Amount-only refunds are unallocated and may include merchandise, shipping, or
tax. They do not infer returned units. Restock and customer-notification choices
are recorded separately. Confirmed returned units use the inventory contract
from #32; requested customer notifications enter the durable messaging outbox
from #12 only after refund success. Effect failures never retry financial work.

## Verification

Database CI must provision clean PostgreSQL, apply every forward migration, set
`RUN_DATABASE_INTEGRATION_TESTS=true`, and fail if the refund integration suite
is skipped. Stripe CLI verification uses test mode only.
