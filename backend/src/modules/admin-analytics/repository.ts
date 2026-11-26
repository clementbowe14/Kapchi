import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  SalesAnalyticsQuery,
  SalesAnalyticsReport,
  SalesBestSeller,
  SalesBreakdown,
  SalesTimeBucket
} from "./types.js";

type BoundRow = QueryResultRow & {
  end_exclusive: Date | string;
  start_inclusive: Date | string;
};

type SummaryRow = QueryResultRow & {
  average_order_value_minor: number | string;
  discount_minor: number | string;
  gross_sales_minor: number | string;
  net_sales_minor: number | string;
  paid_order_count: number | string;
  successful_refunds_minor: number | string;
  units_sold: number | string;
};

type BreakdownRow = QueryResultRow & {
  order_count: number | string;
  status: string;
};

type BucketRow = QueryResultRow & {
  discount_minor: number | string;
  end_exclusive: Date | string;
  gross_sales_minor: number | string;
  net_sales_minor: number | string;
  paid_order_count: number | string;
  start_inclusive: Date | string;
  successful_refunds_minor: number | string;
  units_sold: number | string;
};

type BestSellerRow = QueryResultRow & {
  gross_sales_minor: number | string;
  label: string;
  product_key: string;
  units_sold: number | string;
};

const paidStatuses = ["paid", "partially_refunded", "refunded"];

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeInteger(value: number | string, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`${field} exceeds the safe integer reporting range.`);
  }

  return parsed;
}

function breakdown(rows: BreakdownRow[]): SalesBreakdown[] {
  return rows.map((row) => ({
    count: safeInteger(row.order_count, `${row.status} order count`),
    status: row.status
  }));
}

function timeBuckets(rows: BucketRow[]): SalesTimeBucket[] {
  return rows.map((row) => ({
    discountMinor: safeInteger(row.discount_minor, "bucket discount"),
    endExclusive: iso(row.end_exclusive),
    grossSalesMinor: safeInteger(row.gross_sales_minor, "bucket gross sales"),
    netSalesMinor: safeInteger(row.net_sales_minor, "bucket net sales"),
    paidOrderCount: safeInteger(row.paid_order_count, "bucket paid order count"),
    startInclusive: iso(row.start_inclusive),
    successfulRefundsMinor: safeInteger(row.successful_refunds_minor, "bucket successful refunds"),
    unitsSold: safeInteger(row.units_sold, "bucket units sold")
  }));
}

function bestSellers(rows: BestSellerRow[]): SalesBestSeller[] {
  return rows.map((row) => ({
    grossSalesMinor: safeInteger(row.gross_sales_minor, "best seller gross sales"),
    label: row.label,
    productKey: row.product_key,
    unitsSold: safeInteger(row.units_sold, "best seller units sold")
  }));
}

export interface SalesAnalyticsReader {
  getSalesReport(query: SalesAnalyticsQuery): Promise<SalesAnalyticsReport>;
}

export class SalesAnalyticsRepository implements SalesAnalyticsReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async getSalesReport(query: SalesAnalyticsQuery): Promise<SalesAnalyticsReport> {
    const client = await this.pool.connect();

    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const bounds = await this.loadBounds(client, query);
      const values = [bounds.start_inclusive, bounds.end_exclusive, query.currency];
      const summaryResult = await client.query<SummaryRow>(summarySql, [
        ...values,
        paidStatuses
      ]);
      const paymentResult = await client.query<BreakdownRow>(
        paymentBreakdownSql,
        values,
      );
      const fulfillmentResult = await client.query<BreakdownRow>(
        fulfillmentBreakdownSql,
        values,
      );
      const bucketResult = await client.query<BucketRow>(bucketSql, [
        ...values,
        paidStatuses,
        query.timezone,
        query.bucket
      ]);
      const sellerResult = await client.query<BestSellerRow>(bestSellerSql, [
        ...values,
        paidStatuses,
        query.bestSellerLimit
      ]);
      await client.query("commit");

      const summary = summaryResult.rows[0] ?? {
        average_order_value_minor: 0,
        discount_minor: 0,
        gross_sales_minor: 0,
        net_sales_minor: 0,
        paid_order_count: 0,
        successful_refunds_minor: 0,
        units_sold: 0
      };

      return {
        bestSellers: bestSellers(sellerResult.rows),
        capabilities: {
          refunds: { available: true }
        },
        cohort: {
          basis: "order_created_at",
          bucket: query.bucket,
          bucketTimezone: query.timezone,
          currency: query.currency,
          dateBoundaryTimezone: "UTC",
          endDateInclusive: query.endDate,
          endExclusive: iso(bounds.end_exclusive),
          startDateInclusive: query.startDate,
          startInclusive: iso(bounds.start_inclusive),
        },
        fulfillmentBreakdown: breakdown(fulfillmentResult.rows),
        metadata: {
          amountUnit: "minor",
          grossSalesDefinition:
            "merchandise_before_discounts_shipping_tax_and_refunds",
          netSalesDefinition: "merchandise_less_discounts_less_unallocated_successful_payment_refunds",
          refundCohort: "associated_with_orders_in_created_at_cohort",
          refundCoverage: "recorded_ledger_only",
          source: "postgresql"
        },
        metrics: {
          averageOrderValueMinor: safeInteger(
            summary.average_order_value_minor,
            "average order value",
          ),
          discountMinor: safeInteger(summary.discount_minor, "discount"),
          grossSalesMinor: safeInteger(summary.gross_sales_minor, "gross sales"),
          netSalesMinor: safeInteger(summary.net_sales_minor, "net sales"),
          paidOrderCount: safeInteger(summary.paid_order_count, "paid order count"),
          successfulRefundsMinor: safeInteger(summary.successful_refunds_minor, "successful refunds"),
          unitsSold: safeInteger(summary.units_sold, "units sold")
        },
        paymentBreakdown: breakdown(paymentResult.rows),
        timeBuckets: timeBuckets(bucketResult.rows)
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadBounds(client: PoolClient, query: SalesAnalyticsQuery) {
    const result = await client.query<BoundRow>(
      `
        /* sales_analytics:bounds */
        select
          ($1::date::timestamp at time zone 'UTC') as start_inclusive,
          (($2::date + 1)::timestamp at time zone 'UTC') as end_exclusive
      `,
      [query.startDate, query.endDate],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Unable to resolve sales analytics date boundaries.");
    }

    return row;
  }
}

const paidOrderCte = `
  paid_order_sales as (
    select
      o.id,
      o.created_at,
      o.currency,
      o.discount_cents,
      coalesce(sum(oi.total_amount_cents) filter (
        where oi.currency = o.currency
      ), 0)::bigint as merchandise_minor,
      coalesce(sum(oi.quantity) filter (
        where oi.currency = o.currency
      ), 0)::bigint as units_sold
    from orders o
    left join order_items oi on oi.order_id = o.id
    where o.created_at >= $1
      and o.created_at < $2
      and o.currency = $3
      and o.payment_status = any($4::payment_status[])
    group by o.id, o.created_at, o.discount_cents
  ), paid_orders as (
    select sales.*, refunds.successful_refunds_minor
    from paid_order_sales sales
    cross join lateral (
      select coalesce(sum(r.amount_cents), 0) as successful_refunds_minor
      from refund_operations r
      where r.order_id = sales.id
        and r.status = 'succeeded'
        and r.currency = sales.currency
    ) refunds
  )
`;

const summarySql = `
  /* sales_analytics:summary */
  with ${paidOrderCte}
  select
    coalesce(sum(merchandise_minor), 0)::text as gross_sales_minor,
    coalesce(sum(discount_cents), 0)::text as discount_minor,
    coalesce(sum(successful_refunds_minor), 0)::text as successful_refunds_minor,
    coalesce(
      sum(merchandise_minor) - sum(discount_cents) - sum(successful_refunds_minor), 0
    )::text as net_sales_minor,
    count(*)::text as paid_order_count,
    coalesce(sum(units_sold), 0)::text as units_sold,
    case
      when count(*) = 0 then 0
      else round(
        (sum(merchandise_minor) - sum(discount_cents))::numeric / count(*)
      )
    end::text as average_order_value_minor
  from paid_orders
`;

const paymentBreakdownSql = `
  /* sales_analytics:payment_breakdown */
  select payment_status::text as status, count(*)::text as order_count
  from orders
  where created_at >= $1
    and created_at < $2
    and currency = $3
  group by payment_status
  order by payment_status
`;

const fulfillmentBreakdownSql = `
  /* sales_analytics:fulfillment_breakdown */
  select fulfillment_status::text as status, count(*)::text as order_count
  from orders
  where created_at >= $1
    and created_at < $2
    and currency = $3
  group by fulfillment_status
  order by fulfillment_status
`;

const bucketSql = `
  /* sales_analytics:time_buckets */
  with report_bounds as (
    select $1::timestamptz as start_inclusive, $2::timestamptz as end_exclusive
  ), local_range as (
    select
      start_inclusive,
      end_exclusive,
      date_trunc($6, start_inclusive at time zone $5) as first_local_start,
      (end_exclusive - interval '1 microsecond') at time zone $5 as last_local_instant,
      case $6
        when 'day' then interval '1 day'
        when 'week' then interval '1 week'
        else interval '1 month'
      end as bucket_step
    from report_bounds
  ), bucket_edges as (
    -- Anchor both ends in UTC; a repeated local midnight can resolve after the report start.
    select start_inclusive as edge from report_bounds
    union
    select end_exclusive from report_bounds
    union
    select natural_start at time zone $5 as edge
    from local_range
    cross join lateral generate_series(
      first_local_start + bucket_step, last_local_instant, bucket_step
    ) as local_edge(natural_start)
    where natural_start at time zone $5 > start_inclusive
      and natural_start at time zone $5 < end_exclusive
  ), bucket_bounds as (
    select
      edge as start_inclusive,
      lead(edge) over (order by edge) as end_exclusive
    from bucket_edges
  ), ${paidOrderCte}
  select
    bucket.start_inclusive,
    bucket.end_exclusive,
    coalesce(sum(paid.merchandise_minor), 0)::text as gross_sales_minor,
    coalesce(sum(paid.discount_cents), 0)::text as discount_minor,
    coalesce(sum(paid.successful_refunds_minor), 0)::text as successful_refunds_minor,
    coalesce(
      sum(paid.merchandise_minor) - sum(paid.discount_cents) - sum(paid.successful_refunds_minor), 0
    )::text as net_sales_minor,
    count(paid.id)::text as paid_order_count,
    coalesce(sum(paid.units_sold), 0)::text as units_sold
  from bucket_bounds bucket
  left join paid_orders paid
    on paid.created_at >= bucket.start_inclusive
    and paid.created_at < bucket.end_exclusive
  where bucket.end_exclusive is not null
  group by bucket.start_inclusive, bucket.end_exclusive
  order by bucket.start_inclusive
`;

const bestSellerSql = `
  /* sales_analytics:best_sellers */
  with seller_items as (
    select
      coalesce(
        oi.listing_id::text,
        nullif(oi.listing_snapshot ->> 'slug', ''),
        nullif(oi.stripe_product_id, ''),
        'snapshot:' || md5(oi.listing_snapshot::text)
      ) as product_key,
      coalesce(
        nullif(oi.listing_snapshot ->> 'title', ''),
        nullif(oi.listing_snapshot ->> 'name', ''),
        'Archived product'
      ) as label,
      oi.quantity,
      oi.total_amount_cents,
      o.created_at
    from orders o
    join order_items oi on oi.order_id = o.id and oi.currency = o.currency
    where o.created_at >= $1
      and o.created_at < $2
      and o.currency = $3
      and o.payment_status = any($4::payment_status[])
  )
  select
    product_key,
    (array_agg(label order by created_at desc, label))[1] as label,
    sum(quantity)::text as units_sold,
    sum(total_amount_cents)::text as gross_sales_minor
  from seller_items
  group by product_key
  order by sum(quantity) desc, sum(total_amount_cents) desc, product_key
  limit $5
`;
