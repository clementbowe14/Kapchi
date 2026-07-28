# Stripe Payment Verification

Use this checklist to verify the Stripe payment flow for GitHub issue #24 after
the checkout/session and webhook handlers are available. It covers the required
manual scenarios for successful payment, failed payment, cancellation or
expiration, and duplicate webhook delivery.

## Required Local Environment

Use only local test-mode placeholder values in `backend/.env`. Never paste live
Stripe secrets into local docs, shell history, or logs.

```bash
PORT=4000
STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_WEBHOOK_SECRET=whsec_replace_me
STRIPE_API_VERSION=2026-02-25.clover
DATABASE_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
DATABASE_DIRECT_URL=postgresql://kapchi_local:replace_me_local_password@localhost:5432/kapchi_local
```

Start the backend from the backend workspace:

```bash
cd backend
npm run dev
```

In another terminal, start Stripe CLI forwarding to the local webhook route:

```bash
stripe listen --forward-to localhost:4000/payments/webhooks/stripe
```

Copy the webhook signing secret printed by `stripe listen` into
`STRIPE_WEBHOOK_SECRET` in `backend/.env`, then restart the backend so the new
secret is loaded.

## Security Checks

- Never fulfill or mark an order paid from the success redirect alone. The
  redirect confirms that the customer returned to the app, not that Stripe has
  delivered and signed a successful payment event.
- Require Stripe webhook signature verification for
  `/payments/webhooks/stripe`.
- Do not log `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, raw authorization
  headers, payment method details, or full webhook payloads in normal logs.
- Keep Stripe metadata limited to non-secret identifiers such as `order_id`.

## Database Checks

Run these checks after each scenario. Replace the placeholders with the order,
checkout session, payment intent, and event IDs from the scenario being tested.

```bash
psql "$DATABASE_URL"
```

```sql
select
  id,
  status,
  payment_status,
  stripe_checkout_session_id,
  stripe_payment_intent_id,
  paid_at,
  cancelled_at,
  updated_at
from orders
where id = '<order_id>';
```

When the payment implementation includes a webhook event ledger, verify the
event was recorded once and that retries did not create duplicate processing
records:

```sql
select
  stripe_event_id,
  event_type,
  order_id,
  processed_at,
  processing_error
from stripe_webhook_events
where stripe_event_id = '<stripe_event_id>';
```

Expected ledger behavior:

- The first valid delivery inserts or marks the Stripe event as processed.
- A repeated delivery of the same `stripe_event_id` returns a successful
  webhook response without applying the order transition twice.
- Failed signature verification does not insert an event or mutate an order.

## Scenario 1: Successful Payment

1. Create or select a test cart/order and start checkout through the backend.
2. Open the returned Stripe Checkout URL.
3. Pay with Stripe test card `4242 4242 4242 4242`, any future expiration date,
   any CVC, and any valid postal code.
4. Wait for the signed webhook event to be delivered by `stripe listen`.
5. Confirm the customer may land on the success redirect, but the order is only
   fulfilled after the webhook succeeds.

Expected database state:

- `orders.status` is `paid` or the next configured post-payment production
  state.
- `orders.payment_status` is `paid`.
- `orders.paid_at` is not null.
- `orders.cancelled_at` is null.
- `orders.stripe_checkout_session_id` and `orders.stripe_payment_intent_id`
  match the Stripe objects.
- The webhook event ledger contains the successful Stripe event exactly once.

## Scenario 2: Failed Payment

Use one of these test paths:

- Pay in Checkout with failing card `4000 0000 0000 9995`.
- If the payment implementation includes a Stripe CLI fixture for this flow,
  trigger the fixture and set metadata so it points at the test `order_id`.

Expected database state:

- `orders.status` remains `pending_payment`, unless the implementation has a
  separate failed terminal order state.
- `orders.payment_status` is `failed`.
- `orders.paid_at` is null.
- `orders.cancelled_at` is null unless the implementation explicitly cancels
  failed checkout attempts.
- The webhook event ledger records the failed payment event once.

## Scenario 3: Cancellation Or Expired Session

For customer cancellation:

1. Start checkout through the backend.
2. Open the Checkout URL.
3. Use Checkout's back or cancel control to return to the configured cancel URL.
4. Confirm the redirect alone does not mark the order paid or fulfilled.

For session expiration, expire the Checkout Session from Stripe test mode or use
the implementation's local fixture if one exists.

Expected database state:

- `orders.status` is `cancelled` for a terminal cancellation, or remains
  `pending_payment` if the implementation allows another checkout attempt.
- `orders.payment_status` is `unpaid`, `failed`, or another documented
  cancellation value used by the implementation.
- `orders.paid_at` is null.
- `orders.cancelled_at` is not null only when `orders.status = 'cancelled'`.
- The webhook event ledger records the cancellation or expiration event once
  when Stripe sends one.

## Scenario 4: Duplicate Webhook Delivery

1. Complete one of the scenarios above and note the Stripe event ID from the
   Stripe CLI output or the Stripe Dashboard event detail page.
2. Redeliver the same event to the webhook endpoint. Use the Stripe Dashboard's
   test-mode event resend action, or use Stripe CLI resend against a configured
   test webhook endpoint when available:

```bash
stripe events resend <stripe_event_id> --webhook-endpoint <webhook_endpoint_id>
```

3. Verify both deliveries receive a successful webhook response.

Expected idempotency behavior:

- The order fields are unchanged after the duplicate delivery.
- The ledger still has one row for the same `stripe_event_id`, or one processed
  row plus retry metadata if that is the implementation's documented shape.
- No duplicate order events, fulfillment jobs, emails, inventory releases, or
  production transitions are created for the same Stripe event.

## Verification Notes

Record the following in the PR or release checklist when this manual pass is
performed:

- Stripe event IDs used for success, failure, cancellation or expiration, and
  duplicate delivery.
- Order IDs checked in the database.
- The exact `orders.status`, `orders.payment_status`, `paid_at`, and
  `cancelled_at` values observed for each scenario.
- The webhook ledger rows observed for each scenario.
