# Issue 14 Checkout Workflow

## Goal

Deliver a recoverable hosted-Stripe checkout for guest and authenticated
customers. Fastify remains authoritative for cart ownership, line items, prices,
inventory validation, order creation, and payment state. The browser only sends
customer contact preferences and follows the Stripe URL returned by Fastify.

## Acceptance Criteria

1. Authenticated customers can claim their guest cart, review it, and start
   checkout with their Clerk identity.
2. Guest customers can check out without creating an account.
3. Guest checkout requires a valid email address and phone number.
4. Customers can choose email or phone as their preferred contact method, and
   the backend persists that choice.
5. Checkout submits contact information to Fastify; Fastify derives the cart and
   all monetary values from the authenticated subject or guest session cookie.
6. A successful Stripe return displays the customer's order ID.
7. Field validation and known backend failures produce clear, actionable,
   accessible messages without clearing the form.
8. Invalid, repriced, removed, or unavailable cart items prevent checkout and
   are identified clearly after the cart is refreshed.

## API Contract

### Load cart

`GET /cart/`

- Guest requests include the same-origin `session_id` cookie.
- Authenticated requests include a Clerk bearer token.
- The response contains authoritative item prices, customization summaries,
  validation statuses, and subtotal.

### Claim guest cart

`POST /cart/claim`

- Called after Clerk resolves an authenticated session and before loading the
  account cart.
- A missing guest cart is harmless. Ownership conflicts remain explicit.

### Start checkout

`POST /payments/checkout-sessions`

```json
{
  "customerEmail": "customer@example.com",
  "customerPhone": "+15550101010",
  "preferredContactMethod": "email"
}
```

- Guests must provide both contact values.
- Authenticated customers must provide email; phone is required when phone is
  preferred.
- Unknown fields are rejected. Cart IDs, items, totals, order IDs, and redirect
  URLs are never client-controlled.
- Repeated submissions reuse the open order and Stripe session.
- The response returns `orderId`, `publicOrderNumber`, `paymentStatus`, and the
  hosted Stripe `url`.

### Confirm checkout

Stripe returns to a client confirmation route with its checkout session token.
The client calls an ownership-checked Fastify status endpoint. The response
contains only order identity and payment state, never customer contact data.
The confirmation view polls for a bounded period while webhook processing is
pending and always displays the order ID once ownership is verified.

## Frontend State Model

`auth_loading -> claiming_cart -> loading_cart -> empty | ready | review_required`

`ready -> validating -> submitting -> redirecting`

Failures transition to `validation_error`, `retryable_error`, or `fatal_error`.
Confirmation transitions through `confirming -> pending -> paid | failed`.

- A synchronous submission guard prevents double clicks.
- Retrying an ambiguous timeout is safe because the backend is idempotent.
- Contact values, cookies, auth tokens, checkout session IDs, and Stripe URLs
  are never written to local storage or logs.

## Failure Handling

- Offline, timeout, Stripe `502`, and server `5xx`: retain input, show retry.
- `CART_NOT_FOUND`: show an empty/expired-cart action.
- `CART_NEEDS_REVIEW`: refetch cart, display item-level safe issues, and block
  checkout until all items are valid.
- `CHECKOUT_ALREADY_COMPLETE`: recover through the status endpoint instead of
  creating another order.
- Claim conflict: explain that the cart could not be merged and reload the
  authenticated cart.
- Delayed webhook: show pending state and poll with a bounded retry schedule.
- Duplicate/out-of-order webhook: process idempotently without repeating stock
  or order side effects.
- Persistence failure during webhook processing: return a non-2xx response so
  Stripe retries.

## Observability

Fastify request logs already expose a safe request ID and endpoint latency. Add
checkout lifecycle events for contact validation, cart review, provider calls,
status reads, and webhook outcomes. Safe fields include request ID, internal
order/cart IDs, event/session IDs where operationally required, result code,
attempt, item count, and duration. Never log contact data, cookies, Clerk tokens,
raw Stripe payloads, or hosted checkout URLs.

Client-side diagnostics remain privacy-safe: phase, auth mode, request ID,
status code, backend error code, item count, and elapsed time only.

## Implementation Slices

### Backend agent

- Extend and validate the contact contract and persist preferred contact.
- Return public order identity and item-level review issues.
- Preserve identity when recovering an existing checkout.
- Add a secure success redirect/status recovery contract.
- Wire verified successful Stripe events into the existing idempotent payment
  state handler and expose failures to Stripe.
- Add lifecycle telemetry and focused tests for validation, ownership,
  idempotency, cart review, provider/database failures, and webhook retries.

### Frontend agent

- Build the cart review and checkout form for guest and authenticated customers.
- Claim guest carts after sign-in and use Clerk bearer tokens for account calls.
- Add accessible validation, preferred-contact controls, loading/empty/error
  states, unavailable-item treatment, duplicate-submit protection, and retry.
- Redirect only to a validated hosted checkout URL returned by Fastify.
- Build order confirmation with bounded pending polling and clear recovery UI.
- Add unit/component coverage for all acceptance criteria and failure states.

## Deferred Production Hardening

Queue-based webhook processing, automated reconciliation, rate limiting,
allowlisted CORS/CSRF policy, exported traces/metrics, and database-backed
concurrency suites are valuable follow-ups but are not prerequisites for issue
#14's customer workflow.
