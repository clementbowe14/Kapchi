# Admin authorization and audit contract

Issue #100 defines the shared security boundary for Kapchi shop-manager APIs.
Feature modules still own their request validation, domain rules, persistence,
and tests.

## Verified store role

Every `/admin` route must use `adminRoute(capability)`. The application installs
an `onRoute` boundary that fails startup when an `/admin` endpoint has no known
capability marker. Authentication verifies the Clerk JWT server-side and only
the exact `admin` value from Kapchi's store-role claims grants access.

`org_role` is deliberately excluded from store-role normalization. Clerk
organization administrators, customers, and principals carrying only a
permission string receive `403`. Missing, malformed, expired, or otherwise
invalid tokens receive `401`; token verification failures never become `500`.
The backend never accepts client-supplied actor IDs, roles, capabilities,
ownership fields, or permissions as authorization evidence.

## Capability matrix

| Capability | Access | Protected resources |
| --- | --- | --- |
| `orders:read` | read | Orders, order items, exports, and nested resources |
| `customers:read` | read | Customer profiles and contacts |
| `assets:read` | read | Catalog assets and private customization metadata/content |
| `reports:read` | read | Sales reports and admin exports |
| `inventory:read` | read | Fabric pools and reservation summaries |
| `assets:write` | write | Catalog listing and fabric images |
| `fulfillment:write` | write | Fulfillment state and tracking |
| `order-notes:write` | write | Internal order notes |
| `promotions:write` | write | Promotion definitions and eligibility |
| `messages:write` | write | Order messages and customer notifications |
| `inventory:write` | write | Fabric pools, links, and stock adjustments |
| `refunds:write` | write | Refund requests and reconciliation |

All capabilities currently require the same exact store-admin role. Capability
names are route declarations and audit dimensions, not grants read from a
browser or arbitrary Clerk organization permissions.

Mixed customer/admin endpoints must call `hasStoreAdminRole` for their admin
branch and then enforce the same actor and audit rules. Admin catalog asset
uploads follow this pattern. Private customer assets remain ownership checked;
their storage URL is not returned by customer order endpoints.

## Frontend authentication

Live admin clients obtain a current Clerk token immediately before each API
request and forward it only in the `Authorization: Bearer <token>` header. They
must not cache tokens in local storage, send role or actor fields, or decide
authorization from client claims. A `401` should trigger token refresh or sign
in; a `403` should render an accessible permission error without retrying.

`/admin/demo` remains synthetic. Demo components, fixtures, and simulated
actions must not import the live admin API client, forward Clerk tokens, or
write to Fastify endpoints. Live views must not import demo data.

## API conventions

- Collection endpoints use bounded pagination and a stable secondary sort by
  immutable ID. Cursor values are opaque.
- Amounts are integer minor units and always travel with a lowercase ISO 4217
  currency. Different currencies are never summed.
- Dates are UTC ISO 8601 instants. Date-range reports declare the timezone used
  for bucket boundaries.
- Mutations require `Idempotency-Key` when the operation can be retried and use
  a persisted request fingerprint. Mutable resources use an explicit revision
  or last-known timestamp for optimistic concurrency.
- Validation failures use `400`, authentication failures `401`, authorization
  failures `403`, missing resources `404`, stale/idempotency conflicts `409`,
  provider dependency failures `502`, and temporary unavailability `503`.
- Error bodies contain `error`, `message`, and `statusCode`. Authentication
  errors also return `requestId`. Every response returns `x-request-id`; support
  logs should be searched by that value. Provider payloads, tokens, secrets,
  raw request bodies, and private asset URLs are never included in errors.

## Audit ownership

The authenticated Clerk subject is resolved to an active local `users` row
before an admin mutation. The client cannot choose the actor.

- Order-related state changes, including refunds, fulfillment, and internal
  order notes, use `order_events` with `actor_user_id`, event time, transition
  identity, and safe metadata.
- Non-order mutations without a durable domain audit ledger use
  `admin_audit_events`, which records the verified actor, capability, action,
  target, request ID, optional idempotency key, safe metadata, and database
  timestamp. A feature-specific ledger, such as the shared fabric inventory
  event ledger, remains the sole audit source for that domain and must not also
  write a duplicate generic event.
- Private customization content reads use the dedicated
  `admin_private_asset_access_events` ledger. An `opened` record must be durable
  before response headers are sent; stream completion or failure is updated
  afterward on a best-effort basis.
- Financial records remain in the refund/payment ledgers. Message content and
  delivery state remain in message records. Audit events reference the action
  and identifiers; they do not duplicate financial amounts, provider payloads,
  message bodies, or delivery records.

Admin asset-intent creation is the first non-order integration. The asset and
its audit event are inserted in one PostgreSQL statement, and repeated admin
idempotency keys fail with a structured conflict instead of creating another
pending asset.
