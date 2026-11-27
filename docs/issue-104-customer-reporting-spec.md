# Issue #104: New And Returning Customer Reporting

## Scope

Add `customerBreakdown` to the existing admin sales response for the current
order cohort only. Keep prior-period comparisons, sales metrics, buckets,
order drill-downs, and admin authorization unchanged. No UI, new identity
store, checkout changes, provider calls, backfill, or data migration.
This is a partial delivery of #104: stable identity capture for ordinary guest
checkout remains open. Do not close the issue with this PR.

## Reporting Contract

- Consider orders created within the current inclusive UTC date range and in
  the requested currency. Only `paid`, `partially_refunded`, and `refunded`
  orders qualify. A completed refund does not erase a successful purchase.
- Resolve a durable identity in this order: the order's `authenticated_user_id`,
  the `user_id` on its linked `customers` row, or the order's `customer_id` as
  an unlinked guest/customer record. Keep account IDs and guest IDs in separate
  namespaces. The same customer row now explicitly linked to an account counts
  with that account; a conflicting order-level authenticated ID takes precedence
  for that order. Do not create links or match on email, phone, names, cart/session
  keys, provider IDs, or legacy `orders.user_id` text.
- Return `newCustomerCount` and `returningCustomerCount` as distinct resolved
  identities, counted once and in only one category. A customer is returning if
  any recorded successful purchase under that identity predates the UTC cohort
  start, across all currencies. Otherwise the customer is new to recorded
  history at the start of the report, even with multiple orders in the window.
  Effective success time is the later of order creation and `paid_at`, or just
  creation if `paid_at` is missing. `paid_at` records when Kapchi marked the
  order paid, not necessarily the provider capture time. The creation fallback
  is only an approximation for historical qualifying rows.
  A success at the exact start is not prior history. An order created inside the
  window but paid later is still in the existing live order-created cohort.
- Count qualifying orders without a durable identity in
  `unidentifiedPaidOrderCount`. This is an order count, not an estimate of
  unique people. Ordinary unclaimed guest checkout does not assign a customer
  ID and stays unidentified even with contact details. Seeded guest records
  with customer IDs are not evidence of live guest coverage. Late payment
  confirmation or later changes to identity links can change historic reports.
  Paid order count equals identified orders plus unidentified orders, not the
  sum of the three breakdown fields (resolved identities can order repeatedly).
  There is no guarantee of person-level uniqueness or complete purchase history.
  All three counts are zero for an empty paid cohort. No identity keys, contact
  details, or per-customer rows are returned or logged.

## Implementation And Verification

- One additional aggregate-only query in the existing repeatable-read report.
  Start with the bounded current cohort, deduplicate persisted identities, and
  check only prior successful purchases for those identities. Use `EXISTS`
  probes with direct equality on the raw authenticated user or customer UUID
  and `created_at < cohort_start`, then apply the effective payment-time check.
  The customer probe only includes rows with no explicit authenticated ID.
  Reuse the existing order indexes, unique account-to-customer link, safe
  integer conversion, and explicit UTC SQL parameters. Check the access path
  using `EXPLAIN (ANALYZE, BUFFERS)` against substantial synthetic irrelevant
  history in a disposable database. No cache or new index.
- Test the API shape and privacy plus real PostgreSQL behavior on a disposable
  migrated database. Cover repeated orders, direct and linked account identity,
  stable guest IDs, same-email distinct guests/accounts, conflicts and IDs with
  identical values in different namespaces, and real-world contact-only guest
  or legacy orders as unidentified. Test current currency isolation, cross-
  currency history older than the previous comparison window (which remains
  empty), exact UTC boundaries including a prior order paid at the start,
  delayed `paid_at`, a current order with pre-creation `paid_at`, null `paid_at`
  on a refunded order, unpaid/failed orders, and zero counts when no orders
  qualify. Walk the paid drill-down across pages to reconcile order coverage,
  including repeated resolved orders and an unidentified contact-only guest.
- Use the existing #85 fixture verifier and update its documentation: October
  USD should show four new resolved identities, one returning, and zero
  unidentified orders. Keep existing report and authorization tests passing.
- Update the sales API docs to describe `customerBreakdown` as current-cohort
  only and ordinary unclaimed guest purchases as unidentified orders, not
  unique customers. Document the timestamp and reconciliation limits above.

## Review

Three independent reviewers approved this scope before implementation: identity
and privacy, query and date correctness, and API and verification coverage.
