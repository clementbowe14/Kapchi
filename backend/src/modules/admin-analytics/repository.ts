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
  paid_order_count: number | string;
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
  paid_order_count: number | string;
  start_inclusive: Date | string;
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
    netSalesMinor: null,
    paidOrderCount: safeInteger(row.paid_order_count, "bucket paid order count"),
    startInclusive: iso(row.start_inclusive),
    successfulRefundsMinor: null,
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
        query.startDate,
        query.endDate,
        query.timezone,
        query.bucket,
        query.currency,
        paidStatuses
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
        paid_order_count: 0,
        units_sold: 0
      };

      return {
        bestSellers: bestSellers(sellerResult.rows),
        capabilities: {
          refunds: {
            available: false,
            dependencyIssue: 103,
            reason: "REFUND_LEDGER_UNAVAILABLE"
          }
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
          netSalesDefinition: "unavailable_until_refund_ledger",
          refundCohort: "associated_with_orders_in_created_at_cohort",
          source: "postgresql"
        },
        metrics: {
          averageOrderValueMinor: safeInteger(
            summary.average_order_value_minor,
            "average order value",
          ),
          discountMinor: safeInteger(summary.discount_minor, "discount"),
          grossSalesMinor: safeInteger(summary.gross_sales_minor, "gross sales"),
          netSalesMinor: null,
          paidOrderCount: safeInteger(summary.paid_order_count, "paid order count"),
          successfulRefundsMinor: null,
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
  with paid_orders as (
    select
      o.id,
      o.created_at,
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
  )
`;

const summarySql = `
  /* sales_analytics:summary */
  ${paidOrderCte}
  select
    coalesce(sum(merchandise_minor), 0)::text as gross_sales_minor,
    coalesce(sum(discount_cents), 0)::text as discount_minor,
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
    select
      ($1::date::timestamp at time zone 'UTC') as start_inclusive,
      (($2::date + 1)::timestamp at time zone 'UTC') as end_exclusive
  ), local_range as (
    select
      start_inclusive,
      end_exclusive,
      date_trunc($4, start_inclusive at time zone $3) as first_local_start,
      end_exclusive at time zone $3 as local_end
    from report_bounds
  ), natural_buckets as (
    select generate_series(
      first_local_start,
      local_end - interval '1 microsecond',
      case $4
        when 'day' then interval '1 day'
        when 'week' then interval '1 week'
        else interval '1 month'
      end
    ) as natural_start,
    start_inclusive,
    end_exclusive
    from local_range
  ), bucket_bounds as (
    select
      greatest(
        natural_start at time zone $3,
        start_inclusive
      ) as start_inclusive,
      least(
        (
          natural_start + case $4
            when 'day' then interval '1 day'
            when 'week' then interval '1 week'
            else interval '1 month'
          end
        ) at time zone $3,
        end_exclusive
      ) as end_exclusive
    from natural_buckets
  ), paid_orders as (
    select
      o.id,
      o.created_at,
      o.discount_cents,
      coalesce(sum(oi.total_amount_cents) filter (
        where oi.currency = o.currency
      ), 0)::bigint as merchandise_minor,
      coalesce(sum(oi.quantity) filter (
        where oi.currency = o.currency
      ), 0)::bigint as units_sold
    from orders o
    left join order_items oi on oi.order_id = o.id
    where o.created_at >= ($1::date::timestamp at time zone 'UTC')
      and o.created_at < (($2::date + 1)::timestamp at time zone 'UTC')
      and o.currency = $5
      and o.payment_status = any($6::payment_status[])
    group by o.id, o.created_at, o.discount_cents
  )
  select
    bucket.start_inclusive,
    bucket.end_exclusive,
    coalesce(sum(paid.merchandise_minor), 0)::text as gross_sales_minor,
    coalesce(sum(paid.discount_cents), 0)::text as discount_minor,
    count(paid.id)::text as paid_order_count,
    coalesce(sum(paid.units_sold), 0)::text as units_sold
  from bucket_bounds bucket
  left join paid_orders paid
    on paid.created_at >= bucket.start_inclusive
    and paid.created_at < bucket.end_exclusive
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
