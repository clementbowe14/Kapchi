# Issue #104: Previous-Period Sales Comparisons

## Scope

Add comparisons to the existing admin sales endpoint, using the refund-backed
metrics from PR #143. Keep current metrics and buckets unchanged. No dashboard
UI, comparison charts, customer identity work, new indexes, or provider calls.

## Acceptance Criteria

- For an inclusive UTC date range of N days, compare with the N UTC calendar
  days immediately before it. The previous exclusive end equals the current
  inclusive start. For example, March 1-3, 2024 compares with February 27-29.
  The existing 366-day request limit applies to each period. The IANA
  timezone still only controls current bucket alignment.
- Keep the request contract unchanged. Add `comparison` with `hasBaseline`,
  `previousPeriod`, and `percentChange`. `previousPeriod` includes the same four
  inclusive-date and half-open UTC boundary fields as the current `cohort`,
  the seven existing aggregate `metrics`, and its `drillDown` parameters.
  `percentChange` has one key per metric, with a number in percent units or null.
- `hasBaseline` means the previous period contains at least one matching paid,
  partially refunded, or refunded order. An empty or unpaid-only baseline has
  zero metrics and null changes. A zero previous metric also has null change,
  including zero-to-zero. Otherwise return `(current - previous) /
  abs(previous) * 100`; the sign reflects the direction of change even for
  negative net sales. Percentage values are approximate numbers for display,
  not currency amounts; no presentation rounding in the API.
- Both periods use the same order-created, currency, status, discount, and
  refund rules, with the same repeatable-read snapshot. Later reconciliation
  may change either period. Reuse the existing summary query for the previous
  period; do not load its buckets, best sellers, or breakdowns.
  Bind timezone-explicit UTC strings when passing the resolved bounds back to
  PostgreSQL, so host-local offsets cannot shift a cohort boundary. For the
  `9999-12-31` request, bind the exclusive end in PostgreSQL's unsigned year-10000
  spelling while keeping the current `+010000` ISO response boundary.
- Add `cohort.drillDown` and `comparison.previousPeriod.drillDown` as parameters
  for the corresponding paid-metrics list: `createdFrom`, `createdTo`,
  `currency`, `lifecycle: "all"`, `paidOnly: true`. Add an optional normalized
  currency filter to the existing `GET /admin/orders` route and SQL. Preserve
  default behavior without it. The order date validator must accept valid
  four-digit dates emitted by the analytics response, including a previous
  period that falls below year 0100. Year 0000 is not accepted. Keep the existing
  analytics input limits. Preserve PostgreSQL microseconds in newly issued opaque
  order cursors without changing the public order timestamps or cursor shape.

## Verification

Run backend typecheck/build, route and repository tests, and PostgreSQL
integration tests with `RUN_DATABASE_INTEGRATION_TESTS=true` against a disposable
migrated database. Check leap-day/month and year crossings, the shared exclusive
boundary (an order at that instant is current only), and no change to current
bucket behavior through DST. Cover no baseline, zero metrics with a baseline,
negative net, empty current period, and currency/status exclusions. Use matching
sales and admin order queries on the same data; walk both drill-downs to exhaustion
and assert each exact order ID once, including distinct timestamps in the same
millisecond. Exercise the 366-day `0100-01-01` through `0101-01-01` request and
its valid `0098-12-31` through `0099-12-31` drill-down; reject 367 days and year 0000
at the appropriate routes. Test the `9999-12-31` request against real PostgreSQL.
Verify two summary calls, current-only detail queries, and rollback on a previous
summary failure. Use a query barrier (not a sleep) to commit a successful refund
on a previous-period order from a second connection between the two summary
reads. The in-flight baseline must exclude it and the next report must see it.
Document the additive response and explain that the drill-down is for paid
metrics, not all-payment-status breakdowns.

## Review

Three independent reviews approved the final spec before implementation:
analytics/query correctness, API/drill-down compatibility, and verification.
