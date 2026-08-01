# Redis Guest Cart and Session Storage Strategy

Issue: #36
Parent issue: #27

## Goal

Define the Redis-backed guest cart and short-lived session model so guest cart
display stays fast and ephemeral, while checkout, orders, customer ownership,
and audit-relevant state are persisted in PostgreSQL.

## Current State

- The backend registers a Redis client at startup.
- Guest sessions use a `session_id` cookie.
- Session IDs are generated with 32 random bytes and stored in an HTTP-only
  cookie with `sameSite: "lax"` and `secure` enabled in production.
- Redis session records are stored for seven days under
  `guest_session:<sha256(session_id)>`.
- Guest cart item reads use `guest_cart:<cart_id>:items`.
- The current guest cart item type is `Record<string, unknown>`, so it does not
  yet enforce a minimum data contract.
- PostgreSQL already has durable tables for `carts`, `cart_items`, `orders`,
  `order_items`, customers, customer contacts, assets, and payment state.
- Checkout creation and guest cart claim/merge behavior are not yet fully
  implemented.

## Ownership And Identifier Model

Redis must never store a raw guest session token in a value, and PostgreSQL must
not treat `user_id` as a guest token. Ownership should use separate fields:

- Browser cookie: raw `session_id`, HTTP-only.
- Redis session key: `guest_session:<sha256(session_id)>`.
- Redis session value: `{ "cartId": "<uuid>", "createdAt": "<iso-date>" }`.
- PostgreSQL guest cart ownership: `guest_token_hash = sha256(session_id)`.
- PostgreSQL authenticated ownership: `authenticated_user_id` when an internal
  user row exists, and legacy `user_id` only for auth-provider subject
  compatibility where already present.

The cart ID is the stable cross-store join between Redis display state and
PostgreSQL durable cart/order rows.

## Redis Storage Model

### Guest Session Key

Key:

```text
guest_session:<sha256(session_id)>
```

Value:

```json
{
  "cartId": "uuid",
  "createdAt": "2026-07-31T12:00:00.000Z"
}
```

TTL: seven days.

Purpose: authenticate the browser's guest cart context without storing raw
tokens server-side.

### Guest Cart Display Key

Key:

```text
guest_cart:<cart_id>:items
```

Value:

```json
[
  {
    "cartItemId": "uuid",
    "listingId": "uuid",
    "listingSlug": "graduation-stole",
    "title": "Graduation Stole",
    "quantity": 1,
    "unitAmountCents": 8500,
    "currency": "usd",
    "fabricId": "uuid-or-null",
    "customizationSetId": "uuid",
    "customizationSummary": {
      "line1": "Class of 2026",
      "line2": "Kapchi University",
      "imageAssetId": "uuid-or-null"
    },
    "validationStatus": "valid"
  }
]
```

This value is a display/cache projection only. It must not contain:

- raw session IDs
- payment intent IDs
- Stripe checkout session IDs
- full customer contact records
- shipping addresses beyond a short display summary, if ever needed
- admin/internal notes
- provider secrets or asset private URLs

The complete serialized projection is limited to 64 KiB of UTF-8 data and 100
items. Each item must match the documented shape exactly; if any item is
invalid or contains an unknown field, the entire projection is rejected and
treated as a cache miss. Unknown fields are not stripped. Field limits are:

- `quantity`: integer from 1 through 999
- `unitAmountCents`: integer from 0 through PostgreSQL's signed integer maximum
- `currency`: exactly three lowercase ASCII letters
- `listingSlug` and `title`: 1 through 255 characters
- customization text lines: no more than 512 characters each
- identifiers: valid UUIDs, with only the documented nullable identifiers

These limits protect the cart response from malformed or unexpectedly large
cache values. Code that writes this projection must build a fresh value from
durable rows rather than copying arbitrary request data into Redis.

## PostgreSQL Durable Model

PostgreSQL remains the source of truth for checkout and orders:

- `carts` owns the durable cart shell, status, subtotal, owner, customer, and
  expiration metadata.
- `cart_items` owns the durable line items, selected listing, price variant,
  fabric, quantity, validation status, customization payload, and attached asset
  ID.
- `orders` and `order_items` own checkout/order state after checkout begins.
- `stripe_webhook_events` owns idempotency and Stripe event audit state.
- Redis may be rebuilt from PostgreSQL cart rows, but PostgreSQL order data must
  never depend on Redis as the only copy.

## Expiration Behavior

Guest session expiration has two layers:

- Redis session TTL: seven days from session creation.
- PostgreSQL cart expiration: `carts.expires_at` should match the intended guest
  cart lifetime and be set when a guest cart is created.

The initial implementation uses a fixed lifetime. Reading a guest session does
not renew its Redis TTL, cookie lifetime, or PostgreSQL expiration. The guest
cart display key should receive the same seven-day TTL whenever it is written
or rebuilt.

When a guest session expires:

- The browser no longer resolves to the old Redis session key.
- A new guest session/cart context may be created on the next cart request.
- A background cleanup job or periodic maintenance command should mark expired
  active guest carts as `abandoned`.
- Expired Redis display keys may disappear independently; durable cleanup should
  use PostgreSQL `expires_at`, not Redis key existence.

Checkout-started carts should not be abandoned solely because the Redis session
expires. Checkout expiration should follow Stripe checkout expiration and payment
state rules.

## Guest Cart Creation Consistency

PostgreSQL and Redis cannot participate in one shared transaction. New guest
cart creation therefore follows this order:

1. Insert the active PostgreSQL cart with the hashed guest token and expiration.
2. Write the Redis guest session with its seven-day TTL.
3. Set the browser cookie only after both server-side writes succeed.

If the PostgreSQL write fails, Redis and the response cookie are left untouched.
If the Redis write fails, the backend makes a best-effort update to mark the new
PostgreSQL cart `abandoned`, does not set the cookie, and rethrows the Redis
error. A PostgreSQL cart is inserted for a newly generated identifier rather
than upserted so an unexpected identifier or ownership collision cannot be
silently accepted.

An existing Redis session is reused only when PostgreSQL contains the same cart
ID as an active, unexpired cart owned by the hash of the same cookie. Existing
Redis-only sessions are rotated to a new guest context instead of being
backfilled into PostgreSQL.

## Checkout Transition

At checkout start:

1. Resolve the caller's cart context.
2. For guest checkout, require a valid `session_id` cookie and matching
   `guest_token_hash`.
3. Load the durable `carts` and `cart_items` rows from PostgreSQL.
4. Reprice and revalidate every cart item against current listing, price,
   fabric, inventory/reservation, and customization rules.
5. Create an `orders` row and matching `order_items` rows inside one database
   transaction.
6. Set `carts.status = 'checkout_started'`.
7. Set `orders.payment_status = 'checkout_started'`.
8. Store Stripe checkout identifiers on the order.
9. Keep Redis display data as disposable cache; do not use Redis as the only
   source for order creation.

On successful payment:

1. Stripe webhook handling marks the order paid idempotently.
2. The cart transitions to `converted`.
3. `carts.converted_order_id` is set.
4. Related reservations/assets move to converted or attached states.
5. Guest Redis cart display keys may be deleted or allowed to expire.

On checkout cancellation or expiration:

1. The order moves to the appropriate unpaid/failed/cancelled state.
2. The cart may return to `active` if another checkout attempt is allowed, or
   remain `checkout_started` with explicit retry behavior.
3. Redis display data may be refreshed from PostgreSQL if the customer returns
   to the cart.

## Login And Account Creation Transition

When a guest user signs in or creates an account with an active guest cart:

1. Resolve the guest cart from the `session_id` cookie.
2. Resolve or create the internal `users`, `customers`, and primary
   `customer_contacts` rows.
3. Check whether the authenticated user already has an active cart.
4. If no authenticated active cart exists, claim the guest cart by setting:
   - `carts.authenticated_user_id`
   - `carts.customer_id`
   - `carts.customer_contact_id` when available
   - legacy `carts.user_id` only if needed for existing auth-subject indexes
5. If an authenticated active cart exists, merge valid guest `cart_items` into
   that cart with deterministic conflict rules:
   - identical listing, price variant, fabric, and customization payload:
     combine quantities within allowed limits
   - conflicting customization payloads: keep separate cart items
   - invalid or unavailable guest items: copy with `validation_status` set to
     `invalid` or `needs_reprice`, or skip with a user-visible warning
6. Move guest-owned assets to the claimed/merged cart item when applicable.
7. Mark the old guest cart as `converted` or `abandoned`, depending on whether
   it was claimed or merged away.
8. Delete or expire the old Redis guest display key and set/refresh the
   authenticated cart display state.

This transition must be idempotent so repeated auth callbacks or page reloads do
not duplicate items.

## Proposed Commit Plan

Each commit should be independently reviewable.

### Commit 1: Document Strategy And Data Contract

Files:

- `backend/docs/redis-guest-cart-session-strategy.md`
- `backend/README.md`

Scope:

- Add this strategy document.
- Link it from the Redis section in the backend README.
- Define keys, values, TTLs, PostgreSQL ownership, checkout transition, login
  transition, and security boundaries.

Tests:

- No runtime tests required; docs-only.

### Commit 2: Type And Validate Redis Guest Cart Data

Files:

- `backend/src/modules/cart/guest-session.ts`
- `backend/src/modules/cart/guest-session.test.ts`

Scope:

- Replace `Record<string, unknown>` guest cart items with an explicit
  `GuestCartDisplayItem` type.
- Validate parsed Redis cart display data before returning it.
- Reject the entire projection when it is malformed, sensitive, oversized, or
  contains an unknown field.
- Keep Redis values as a display projection, not checkout source of truth.

Tests:

- Valid display item parses.
- Missing/malformed/non-array values return an empty cart.
- Sensitive fields such as Stripe IDs, tokens, private URLs, or internal notes
  reject the complete projection.
- Invalid quantities, currencies, UUIDs, or validation statuses are rejected.

### Commit 3: Create Durable Guest Cart Records With Redis Sessions

Files:

- `backend/src/modules/cart/guest-session.ts`
- `backend/src/modules/cart/plugin.ts`
- `backend/src/modules/cart/guest-session.test.ts`

Scope:

- When creating a guest session, also create or upsert a PostgreSQL `carts` row
  with `guest_token_hash`, `status = 'active'`, and `expires_at`.
- Ensure Redis session `cartId` points at an existing durable cart.
- Keep raw session IDs out of PostgreSQL.

Tests:

- New guest session writes Redis session and durable PostgreSQL cart.
- Existing valid Redis session resolves only if the durable cart is still active.
- Expired or abandoned carts force a new guest cart context.

### Commit 4: Implement Cart Mutation And Redis Projection Refresh

Files:

- `backend/src/modules/cart/plugin.ts`
- `backend/src/modules/cart/guest-session.ts`
- related cart tests

Scope:

- Add cart item add/update/remove endpoints if still missing.
- Persist cart mutations to PostgreSQL `cart_items`.
- Refresh `guest_cart:<cart_id>:items` from durable PostgreSQL rows after
  mutations.
- Treat Redis misses as cache misses and rebuild from PostgreSQL.

Tests:

- Add item persists to PostgreSQL and refreshes Redis projection.
- Update quantity/customization revalidates and refreshes projection.
- Remove item deletes durable row and refreshes projection.
- Redis unavailable paths return a controlled error or rebuild behavior.

### Commit 5: Implement Checkout Materialization From PostgreSQL

Files:

- `backend/src/modules/payments/plugin.ts`
- payment/cart/order helper modules
- related tests

Scope:

- Start checkout from durable PostgreSQL cart rows.
- Reprice and revalidate all items before creating Stripe checkout.
- Create `orders` and `order_items` inside a transaction.
- Set cart/order checkout status fields.
- Ensure Redis is never the only source for order creation.

Tests:

- Guest checkout creates order/order_items from PostgreSQL cart/cart_items.
- Empty, expired, invalid, or unavailable carts are rejected.
- Stripe failure does not leave partially converted durable state.
- Successful checkout start records Stripe identifiers and expiration.

### Commit 6: Implement Guest Cart Claim/Merge On Login

Files:

- auth/customer/cart modules
- related tests

Scope:

- Add an idempotent service that claims or merges the active guest cart when a
  user signs in or creates an account.
- Attach customer/user/contact IDs to the resulting cart.
- Move guest assets and cart items safely.
- Delete or expire stale guest Redis projection keys.

Tests:

- Guest cart claim when user has no active cart.
- Guest cart merge when user already has an active cart.
- Duplicate auth callbacks do not duplicate items.
- Conflicting customizations remain separate.
- Invalid guest items are marked or skipped according to the approved rule.

## Security And Edge Cases

- Never log or persist raw `session_id` values.
- Hash guest session IDs before using them in Redis keys or PostgreSQL fields.
- Keep Redis cart display data small and non-sensitive.
- Checkout and order creation must load from PostgreSQL, not Redis.
- Cart claim/merge must be idempotent.
- Guest cart ownership checks must compare the hashed session ID to the durable
  cart owner.
- Do not expose private asset URLs through cart display payloads.
- Expired Redis keys must not erase durable order data.

## Acceptance Criteria Mapping

- Guest carts have a clear Redis storage model: addressed by the storage model
  section.
- Guest carts are keyed by a secure guest/session/cart identifier: addressed by
  the ownership and identifier model.
- Cart data stored in Redis contains only the minimum data needed for
  checkout/cart display: addressed by the display key data contract.
- Durable order data is written to PostgreSQL, not Redis only: addressed by the
  durable model and checkout transition.
- Guest cart expiration behavior is defined: addressed by expiration behavior.
- Strategy explains how guest carts transition into orders at checkout:
  addressed by checkout transition.
- Strategy explains what happens when a guest user logs in or creates an
  account: addressed by login and account creation transition.
