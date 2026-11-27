# Issue #104: Refund-Backed Sales Metrics

## Scope

Complete the refund and net-sales slice of the existing admin sales endpoint.
Leave customer identity, period comparisons, and dashboard UI for separate PRs.

## Contract

- For the existing paid order cohort, sum `refund_operations.amount_cents` for
  `succeeded` operations linked by order ID and matching the order currency.
  Include both Kapchi and reconciled Stripe-originated operations. Pending and
  failed amounts do not reduce sales, and no amount is inferred from order status.
- Attribute refunds to the order creation bucket even if the refund succeeds
  outside the requested dates. This is a live order-cohort view, not cash flow.
  Buckets must cover the entire UTC report window without overlap or gaps. Fix
  existing boundary clipping if a timezone transition repeats local midnight;
  do not change the cohort filter or add a separate bucketing system.
- Keep the same route, query, and field paths. Return safe integer minor units
  instead of null for `successfulRefundsMinor` and `netSalesMinor` in the summary
  and every bucket. Net is gross minus discounts minus the full recorded amount
  of every eligible successful operation, partial or full. Refunds can include
  shipping or tax; do not allocate, prorate, or clamp the resulting net. Empty
  periods return zero. Keep gross, AOV, units, breakdowns, and best sellers intact.
- Set `capabilities.refunds` to `{ available: true }`, dropping the unavailable
  reason and dependency. Keep `metadata.refundCohort`, add `metadata.refundCoverage`
  as `recorded_ledger_only`, and use
  `merchandise_less_discounts_less_unallocated_successful_payment_refunds` for
  `metadata.netSalesDefinition`. Availability means the ledger is queryable,
  not complete. Zero means no qualifying success is recorded, even on a legacy
  refunded order. There is no historical or unreconciled-provider backfill;
  later reconciliation can change reporting periods. The report end is not an
  as-of cutoff. Deploy the existing ledger migration first; a missing schema
  follows the route's normal internal-error path and must not return zero.

## Implementation and Verification

Reuse the report's repeatable-read transaction and existing order/status ledger
index. Aggregate refunds independently at order granularity before combining with
items, so multiple refund operations and items cannot multiply each other. Keep
integer arithmetic in PostgreSQL and use the existing safe-number conversion at
the API boundary. No migrations, caching, or provider calls are needed.

Update response fixtures and documentation. Run the PostgreSQL integration suite
with `RUN_DATABASE_INTEGRATION_TESTS=true` on a disposable fully migrated database.
Cover a partially refunded order, plus an order with two matching items and two
successes (one per origin) totaling the captured amount including shipping/tax and
yielding negative net. Create and succeed one refund after the report ends. Cover
pending and failed operations, a wrong-currency refund on an eligible order,
unpaid and out-of-range records, and a legacy refunded order with no ledger rows.
Use test-local ledger rows and delete them before their orders. Assert bucket
reconciliation and empty-period zeros. Use the mocked DB error test to verify a
missing relation rejects and rolls back without changing the schema. Keep route,
role, range, and DST coverage passing. In `Atlantic/Azores`, verify a daily
report starting on `2026-10-25` puts a `00:30Z` order and its successful refund
in the first bucket even though the local midnight repeats.

## Review

Three independent reviews approved the revised spec before implementation:
SQL and timezone correctness, API and reporting semantics, and test coverage.
