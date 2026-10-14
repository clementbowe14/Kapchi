# Shared fabric inventory

Issue #32 extends the existing `fabrics`, `listing_fabrics`, and
`fabric_reservations` model. It does not introduce listing-level stock or infer
finished-product quantities from fabric pools.

## Accounting contract

`fabric_inventory_availability` is the read contract used by public listings,
checkout validation, and admin inventory:

```text
available = on hand - order reservations - active cart holds
```

- A live reservation with an `order_id` is an order reservation, even while it
  still has its source `cart_id`. It is counted once.
- A live reservation without an order is a cart hold.
- Released, expired, and converted reservations are not counted.
- Active reservations whose `expires_at` is in the past are not counted. The
  reconciliation worker changes them to `expired` and repairs the stored
  `quantity_reserved` counter.
- A fabric pool appears once in admin totals even when multiple listings point
  to it. Linked listing identifiers are returned on the pool.
- Non-fabric listings return `untracked` with
  `FINISHED_PRODUCT_LEDGER_UNAVAILABLE`. Fabric inventory is never presented as
  a finished-product quantity.

Run stale-hold reconciliation at least once per minute:

```bash
npm run inventory:reconcile
```

Cart mutations also reconcile the selected pool before reserving it, and admin
reads reconcile their requested pool (or all pools when unfiltered).

## Lifecycle

1. Adding or updating a fabric-backed cart item atomically increments the
   fabric's stored reserved quantity and creates or updates one active hold.
2. Checkout links that same reservation to its order and order item. No second
   reservation is created.
3. A verified Stripe payment success locks the order items, reservations, and
   fabrics in one database transaction. It decrements on-hand and reserved,
   increments sold, marks reservations `converted`, and writes one idempotent
   `payment_consumed` audit event per order item.
4. Replayed Stripe events return `already_paid` and do not consume stock again.
5. Checkout cancellation or abandonment releases active unpaid reservations.
   A recoverable cart retains its hold so the customer can retry checkout.
6. Refund amount alone never infers returned units. Restock requires an exact
  paid `orderItemId`, a confirmed usable quantity, an explicit
  `usableUnitsConfirmed: true` acknowledgement, a reason, and an idempotency
  key. Cumulative restocks cannot exceed the purchased quantity.

Historical order item fabric snapshots remain readable after a fabric or link
is archived.

## Admin API

All routes require a verified Clerk token with the exact `admin` role. Mutating
routes also require an active local user record and an `Idempotency-Key` header.
Issue #100 will replace this temporary role boundary with the final shop-manager
permission contract.

- `GET /admin/inventory`: search unique pools by fabric, SKU, or linked product;
  filter with `stock`, `lowStockThreshold`, `fabricId`, or `listingId`.
- `POST /admin/inventory/fabrics`: create a fabric and initial on-hand balance.
- `PATCH /admin/inventory/fabrics/:fabricId`: update metadata or archive/reactivate.
- `POST /admin/inventory/fabrics/:fabricId/adjustments`: apply a signed on-hand
  correction. Reductions below stored reservations are rejected under lock.
- `PUT /admin/inventory/fabrics/:fabricId/listings/:listingId`: create or update
  a fabric-backed listing link.
- `POST /admin/inventory/fabrics/:fabricId/restocks`: restock confirmed usable
  returned units for a specific paid order item.

Every mutation writes `fabric_inventory_events` with the verified actor,
request fingerprint, idempotency key, reason, deltas, and relevant identifiers.
Concurrent requests sharing a key serialize on a transaction advisory lock;
same-input retries replay while different-input reuse returns a conflict.
