# Admin Sales Analytics

`GET /admin/analytics/sales` returns a bounded, single-currency order-cohort
report for verified store administrators. PostgreSQL is the source of truth; the
endpoint does not cache results.

## Query

| Parameter | Contract |
| --- | --- |
| `startDate` | Required `YYYY-MM-DD`, inclusive at 00:00 UTC. |
| `endDate` | Required `YYYY-MM-DD`, inclusive through the UTC calendar day. |
| `timezone` | Required IANA timezone used to align time buckets. |
| `currency` | Required three-letter lowercase currency code. |
| `bucket` | Optional `day`, `week`, or `month`; defaults to `day`. |
| `bestSellerLimit` | Optional integer from 1 through 50; defaults to 10. |

The inclusive date range is capped at 366 calendar days. The response includes
the resolved UTC `startInclusive` and `endExclusive` boundaries. Buckets align to
the requested timezone and clip to the report boundaries, so the first or last
bucket can be partial. All component queries use the same half-open UTC boundaries
and one repeatable-read transaction.

## Definitions

- The cohort is selected by `orders.created_at`, not payment or refund date.
- `paid`, `partially_refunded`, and `refunded` orders contribute to sales.
- Gross sales are matching-currency order-item totals before discounts and
  exclude shipping, tax, and refunds.
- Discounts are order-level discount minor units for the paid cohort.
- Average order value is `(gross - discounts) / paid orders`, rounded to the
  nearest integer minor unit before refunds.
- Units sold are order-item quantities before returns.
- Payment and fulfillment breakdowns include paid and unpaid orders in the same
  date and currency cohort.
- Best sellers use immutable listing snapshot labels, so archived products remain
  identifiable.

All money fields are integer minor units. Every query filters the order currency,
and item aggregates additionally require `order_items.currency = orders.currency`.
The endpoint never converts or adds different currencies.

## Refunds And Net Sales

`successfulRefundsMinor` sums successful, same-currency ledger operations for
orders in the paid cohort, including reconciled Stripe-originated refunds.
Pending and failed refunds are excluded. `netSalesMinor` subtracts discounts
and the entire successful payment refund amount from gross merchandise sales.
The ledger does not separate merchandise, shipping, and tax refunds, so net can
be negative. Neither field represents cash flow.

The summary and every bucket return integers, with zero for empty periods.
Refunds are assigned to their order's creation bucket, regardless of refund
date. Reconciliation can change historical totals; the end date is not an
as-of cutoff. `capabilities.refunds.available` is true when this report is
available, not a guarantee of historical coverage. The `recorded_ledger_only`
coverage excludes unrecorded refunds, even for orders marked refunded. Apply the
existing refund ledger migration before deploying this code; missing schema
fails the report instead of returning zero.

## Authorization And Freshness

The route requires a verified `admin` role through the shared Fastify auth
guards. Customer and organization-only roles are not sufficient. Results are
read directly from PostgreSQL on every request, so payment, order, and
refund commits are visible to the next report without cache invalidation.
