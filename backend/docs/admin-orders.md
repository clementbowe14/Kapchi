# Admin order API

Issue #11 provides read-only order search, detail, and history contracts for the
Kapchi shop manager. Read routes use the shared `orders:read` capability; issue
#21 production commands use `fulfillment:write`. Every route requires the exact
verified store-admin role. The public demo must not call these endpoints.

## Search

`GET /admin/orders` returns a stable page ordered by `created_at` and order ID.
The default is newest-first and excludes completed and cancelled orders.

Supported query fields:

- `search`: public order number, customer name, or normalized email. `%`, `_`,
  and `\` are treated literally.
- `createdFrom` and `createdTo`: optional inclusive UTC calendar dates. A range
  is bounded to 366 days.
- `currency`: optional three-letter currency code, normalized to lowercase.
- `orderStatus`, `paymentStatus`, and `fulfillmentStatus`: independent status
  filters.
- `listingId` and `fabricId`: historical item drill-down filters.
- `paidOnly`, `discountedOnly`, and `refundedOnly`: paid cohorts, discounted
  orders, and orders with a successful refund operation.
- `lifecycle`: `ongoing`, `completed`, `cancelled`, or `all`. An explicit
  `orderStatus` takes precedence.
- `sort`: `created_desc` or `created_asc`.
- `limit` and opaque `cursor`: stable keyset pagination. A cursor cannot be
  reused with a different sort direction.

List rows include contact snapshots where available, item counts, integer
minor-unit totals, reconciliation-backed captured amount, succeeded and pending
refunds, and refundable balance. A missing reconciliation state or currency
mismatch is explicit; payment movement is never inferred from an order status.

## Detail

`GET /admin/orders/:orderId` returns:

- order, payment, fulfillment, shipping, and contact snapshots;
- item quantities and integer minor-unit prices;
- immutable listing, fabric, and customization snapshots exactly as stored;
- exact stored text, accents, font, trim, and placement values;
- production notes, priority, and estimate snapshots;
- canonical customization asset IDs and an explicit missing/not-selected state;
- archived live-catalog reference status without replacing historical values;
- fulfillment and shipment records without private label or storage URLs.

Production fields use `present`, `not_selected`, or `not_stored`. The serializer
does not fill absent values from current catalog data or demo fixtures. Private
asset delivery remains the responsibility of issue #101.

## Timeline

`GET /admin/orders/:orderId/timeline` returns chronological keyset-paginated
entries from order events, messages, internal notes, and refund operations.
Each entry states whether it is internal or customer-visible and includes the
stored actor identity when available.

Message/note delivery events and refund transition events are omitted from the
generic event source because their authoritative message/refund records are
already returned. This prevents duplicate history rows while preserving other
order lifecycle events.

## Production lifecycle commands

Issue #21 adds narrow commands instead of a generic status setter. Both routes
require the `fulfillment:write` capability, a verified active local admin, an
`Idempotency-Key` header of 1–128 characters, and an `expectedRevision` from the
latest order response:

- `POST /admin/orders/:orderId/actions/start-production` moves
  `paid/queued` to `in_production/in_progress`.
- `POST /admin/orders/:orderId/actions/mark-ready-to-ship` moves
  `in_production/in_progress` to `ready_to_ship/ready_to_ship`.

The body is `{ "expectedRevision": 0, "reason": "optional internal reason" }`.
The reason is audit-only and is never returned by customer order APIs.

Only orders with a recorded payment timestamp and payment status `paid` or
`partially_refunded` may transition. A full refund, cancellation, shipment,
completion, missing payment, unexpected source state, or stale revision returns
HTTP 409 without changing the order. A partial refund alone does not imply a
returned item and therefore does not stop an otherwise valid production
transition.

Accepted mutations update order and fulfillment state together, increment the
order revision once, and append an actor-attributed `order_events` record in the
same transaction. Replaying the same idempotency key and request returns the
stored result without another revision or event. Reusing the key with different
input returns `IDEMPOTENCY_CONFLICT`. Idempotency keys are hashed before their
identity is stored and are not logged.

Shipping confirmation, cancellation/inventory release, address edits, tracking,
and partial-shipment aggregation remain separate issue #21 review units. In
particular, these commands cannot mark an order shipped without confirmed
shipment data.

## Failure states and observability

- malformed filters and cursors return `VALIDATION_ERROR` or `INVALID_CURSOR`;
- unknown orders return `ORDER_NOT_FOUND`;
- non-admin callers receive the shared unauthorized/forbidden responses;
- recognized database availability failures return
  `ADMIN_ORDERS_UNAVAILABLE`, HTTP 503, and `Retry-After: 30`;
- completion logs include order IDs, result counts, paging state, and filter
  modes, but never contact data, addresses, message bodies, or snapshot data.
- lifecycle completion logs include the command, order and fulfillment states,
  replay flag, and revision, but not the idempotency key or audit reason.
