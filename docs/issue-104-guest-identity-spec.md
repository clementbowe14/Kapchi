# Issue #104: Durable Guest Attribution

## Scope

Recognize repeat guest purchases made in the same browser, even when checkout
creates a new guest cart and session. This is first-party sales reporting, not
identity verification. A browser may be shared, and clearing cookies, using a
different browser/device or API host, or expiry can split the same person into
multiple identities. No email, phone, contact, provider, or device matching.
No historical backfill, sign-in linking, guest authorization changes, UI, or
third-party tracking.

## Capture And Privacy

- Add optional backend `GUEST_ANALYTICS_COOKIE_SECRET` (at least 32 bytes of
  high-entropy secret material). Unset means no capture, reuse, or new cookie.
  Do not log the secret. Before backend promotion, apply and verify the exact
  release's migration, even with capture off. Treat rollback to an older
  migration manifest as readiness-incompatible unless rehearsed; use the
  existing production rollback runbook and prefer rolling forward. Deploy with
  the secret unset. Before configuring it in production, require owner-approved
  disclosures and retention for stored digests, and have applicable consent and
  preference controls in place and verified. Existing checkout acknowledgement
  is not analytics consent. Do not approve/change policy wording or enable the
  feature on a hosted environment in this PR.
- After existing request and cart-owner validation on `POST /payments/checkout-sessions`,
  guest checkout may read its own analytics cookie. Authenticated requests
  ignore it. `Sec-GPC: 1` prevents use and issuance and clears a present analytics
  cookie on an otherwise authorized guest checkout attempt. It does not remove
  historic attribution automatically or change existing checkout behavior.
- Use one versioned, HMAC-authenticated cookie with a fixed 90-day expiry,
  verified server-side with bounded parsing, constant-time signature comparison,
  and the existing injectable clock. Absent, invalid, tampered or expired
  cookies allow a fresh 32-byte random key only for a newly inserted eligible
  order. Never derive it from cart identifiers, contact information, or tokens.
  Rotating the signing secret invalidates previously issued cookies.
- Write a fresh cookie only on a successful `201` checkout response whose final
  order was inserted by that preparation and committed the same key's digest.
  Pass the fresh key only as transient internal metadata from repository to
  service to route; explicitly exclude it from the HTTP result. A reused order
  never mints a cookie, even when attribution is null, matches, or differs from
  the request. Losing the initial response or provider failure may therefore
  leave that browser unidentified for future orders; do not recreate a cleared
  or expired identity on retry. A terminal replacement order uses the current
  eligible request's valid cookie or a fresh independent key when newly
  inserted. Only the final preparation can supply a key to issue; preserve the
  original digest and Stripe's order-scoped idempotency behavior. Keep the cookie
  host-only, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` with an `__Host-` name
  on HTTPS hosted deployments (plain local/test name for HTTP). Do not refresh
  an unexpired cookie or put it in JSON, URLs, Stripe metadata, or logs.
  Credentialed storefront/API requests must be same-site for reuse.

## Persistence And Reporting

- Add a nullable `orders.guest_analytics_digest` for a lowercase SHA-256 hex
  digest of the opaque key, plus a partial index on `(guest_analytics_digest,
  created_at)` for non-null values. Only a newly inserted guest order with no
  account or customer owner gets a digest, in the existing checkout transaction.
  `user_id`, `authenticated_user_id`, and `customer_id` must all be null.
  Ineligible, disabled or opted-out orders store null. Keep existing prepared
  orders immutable on retry or cookie changes. The cookie cannot authorize
  checkout, lookup, confirmation, cart claims, or artwork access. Do not persist
  the cookie, signature, session token, or a separate customer record.
- Add a separate browser-key identity to the existing aggregate as a fallback
  only when neither direct account nor linked/unlinked customer ID is present.
  Retain the same paid, UTC, currency-cohort and lifetime-history rules from
  #145. Require all three owner fields to be null for current and historical
  browser matches, including legacy `user_id` text. Probe history once for each
  distinct key using direct digest equality and `created_at < cohort_start`,
  with the existing effective paid-time filter. Old and uncaptured guest orders
  remain unidentified. Keep API shape
  and all existing access controls. No raw data or digests in API output or logs.
- Document that cookie expiry, opt-out and disabling capture affect future
  attribution; stored digests remain with order records until removed. Document
  a scoped operator process to clear `guest_analytics_digest` without deleting
  orders, and retain no new background job or privacy infrastructure here.

## Verification

- Test valid/invalid/expired/tampered cookies, signature boundaries and safe
  attributes, no refresh, forged body fields, unauthorized and account-owner
  routes, disabled capture and GPC, and no identity in JSON or provider requests.
- In disposable PostgreSQL, use real checkout preparation to verify retries
  preserve the first attribution and only the first writer mints on concurrent
  same-cart requests. Cover provider failure then reused success (same, different
  and null stored attribution), GPC clear/expired-cookie retry without revival,
  and terminal replacement selecting the final freshly inserted order. Verify
  unchanged cart/order ownership and reuse across new carts.
- Test one new identity for repeat orders in the current cohort; a same-key
  earlier success in another currency makes it returning. A purchase paid
  exactly at UTC start or attached to a direct, linked/unlinked, or legacy
  owner cannot count as browser history. Other browser keys with matching
  contacts do not merge, and no digest stays unidentified. Verify the partial
  index with `EXPLAIN (ANALYZE, BUFFERS)` on substantial unrelated synthetic
  history. Migrations, backend build/typecheck, analytics and payment regression
  tests must pass. Document browser identities versus unique people.

## Review

Three independent reviewers approved the revised spec before implementation:
privacy and authorization, checkout and rollout behavior, and reporting and tests.
