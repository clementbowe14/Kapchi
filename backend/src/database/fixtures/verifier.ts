import type { Pool, QueryResultRow } from "pg";
import { SalesAnalyticsRepository } from "../../modules/admin-analytics/repository.js";
import {
  expectedCurrentUsdAnalytics,
  fixtureCarts,
  fixtureOrders,
  reportingWindows
} from "./admin-workflows.js";
import { operationalReferences } from "./core.js";
import { verifyOperationalFixtures } from "./operational.js";
import {
  FixtureSafetyError,
  assertInitializedFixtureDatabase,
  stableJson,
  type FixtureQueryable
} from "./safety.js";

type CountRow = QueryResultRow & { count: number | string };

async function count(db: FixtureQueryable, sql: string, values: unknown[] = []) {
  const result = await db.query<CountRow>(sql, values);
  return Number(result.rows[0]?.count ?? 0);
}

function fail(code: string, tableAlias: string) {
  throw new FixtureSafetyError(
    "FIXTURE_VERIFICATION_FAILED",
    code,
    tableAlias,
  );
}

export async function verifyFixtureDatabase(input: {
  databaseUrl?: string;
  db: FixtureQueryable & Partial<Pick<Pool, "connect">>;
  nodeEnv?: string;
  token?: string;
}) {
  await assertInitializedFixtureDatabase(input);
  const orderIds = fixtureOrders.map((order) => order.id);

  const ownershipCount = await count(
    input.db,
    "select count(*) from kapchi_fixture.owned_rows",
  );
  if (ownershipCount === 0) fail("FIXTURE_OWNERSHIP_EMPTY", "owned_rows");

  const orderCount = await count(
    input.db,
    "select count(*) from orders where id = any($1::uuid[])",
    [orderIds],
  );
  if (orderCount !== fixtureOrders.length) fail("FIXTURE_ORDER_COUNT", "orders");

  const invalidOrders = await count(
    input.db,
    `select count(*) from orders o
      where o.id = any($1::uuid[]) and (
        o.stripe_checkout_session_id is not null or
        o.total_cents <> o.subtotal_cents + o.shipping_cents + o.tax_cents - o.discount_cents
      )`,
    [orderIds],
  );
  if (invalidOrders) fail("FIXTURE_ORDER_INVARIANT", "orders");

  const invalidItems = await count(
    input.db,
    `select count(*) from order_items oi join orders o on o.id=oi.order_id
      where o.id = any($1::uuid[]) and (
        oi.total_amount_cents <> oi.unit_amount_cents * oi.quantity or
        oi.currency <> o.currency
      )`,
    [orderIds],
  );
  if (invalidItems) fail("FIXTURE_ORDER_ITEM_INVARIANT", "order_items");

  const quantityOverflow = await count(
    input.db,
    `select count(*) from order_items oi
      where oi.id = any($1::uuid[]) and (
        coalesce((select sum(ofi.quantity) from order_fulfillment_items ofi where ofi.order_item_id=oi.id),0) > oi.quantity or
        coalesce((select sum(si.quantity) from shipment_items si where si.order_item_id=oi.id),0) > oi.quantity
      )`,
    [fixtureOrders.map((order) => order.itemId)],
  );
  if (quantityOverflow) fail("FIXTURE_QUANTITY_OVERFLOW", "fulfillment");

  const analytics = await input.db.query<
    QueryResultRow & {
      average_order_value_minor: number | string;
      discount_minor: number | string;
      gross_sales_minor: number | string;
      paid_order_count: number | string;
      units_sold: number | string;
    }
  >(
    `with paid_orders as (
       select o.id, o.discount_cents,
         coalesce(sum(oi.total_amount_cents) filter (where oi.currency=o.currency),0)::bigint merchandise_minor,
         coalesce(sum(oi.quantity) filter (where oi.currency=o.currency),0)::bigint units_sold
       from orders o left join order_items oi on oi.order_id=o.id
       where o.created_at >= $1 and o.created_at < $2 and o.currency='usd'
         and o.payment_status in ('paid','partially_refunded','refunded')
       group by o.id,o.discount_cents
     ) select coalesce(sum(merchandise_minor),0)::text gross_sales_minor,
       coalesce(sum(discount_cents),0)::text discount_minor, count(*)::text paid_order_count,
       coalesce(sum(units_sold),0)::text units_sold,
       case when count(*)=0 then 0 else round((sum(merchandise_minor)-sum(discount_cents))::numeric/count(*)) end::text average_order_value_minor
     from paid_orders`,
    [reportingWindows.current.startInclusive, reportingWindows.current.endExclusive],
  );
  const actual = analytics.rows[0];
  const expected = expectedCurrentUsdAnalytics.metrics;
  if (
    !actual ||
    Number(actual.gross_sales_minor) !== expected.grossSalesMinor ||
    Number(actual.discount_minor) !== expected.discountMinor ||
    Number(actual.paid_order_count) !== expected.paidOrderCount ||
    Number(actual.units_sold) !== expected.unitsSold ||
    Number(actual.average_order_value_minor) !== expected.averageOrderValueMinor
  ) {
    fail("FIXTURE_ANALYTICS_MISMATCH", "analytics");
  }

  if (typeof input.db.connect === "function") {
    const report = await new SalesAnalyticsRepository(
      input.db as Pick<Pool, "connect">,
    ).getSalesReport({
      bestSellerLimit: 10,
      bucket: "day",
      currency: "usd",
      endDate: "2026-10-31",
      startDate: "2026-10-01",
      timezone: "UTC"
    });
    if (
      stableJson(report.metrics) !== stableJson(expected) ||
      stableJson(report.paymentBreakdown) !== stableJson(expectedCurrentUsdAnalytics.paymentBreakdown) ||
      stableJson(report.fulfillmentBreakdown) !== stableJson(expectedCurrentUsdAnalytics.fulfillmentBreakdown) ||
      stableJson(report.bestSellers) !== stableJson(expectedCurrentUsdAnalytics.bestSellers)
    ) {
      fail("FIXTURE_ANALYTICS_REPOSITORY_MISMATCH", "analytics");
    }
  }

  const inventory = await input.db.query<
    QueryResultRow & { available_quantity: number; cart_held_quantity: number; sku: string }
  >(
    `select sku,available_quantity,cart_held_quantity from fabric_inventory_availability
      where sku in ('LOCAL-SEED-NAVY-SATIN','LOCAL-SEED-GOLD-SATIN') order by sku`,
  );
  const navy = inventory.rows.find((row) => row.sku === "LOCAL-SEED-NAVY-SATIN");
  if (!navy || Number(navy.cart_held_quantity) !== 1 || Number(navy.available_quantity) !== 39) {
    fail("FIXTURE_INVENTORY_MISMATCH", "fabric_inventory_availability");
  }

  const activeCart = await count(
    input.db,
    `select count(*) from carts c join fabric_reservations fr on fr.cart_id=c.id
      where c.id=$1 and c.status='active' and fr.status='active' and fr.expires_at > now()`,
    [fixtureCarts.active.id],
  );
  if (activeCart !== 1) fail("FIXTURE_ACTIVE_CART_MISSING", "carts");

  const activeExports = await count(
    input.db,
    `select (
       (select count(*) from shipping_export_active_memberships memberships
         join shipping_export_batches batches on batches.id=memberships.batch_id
         where batches.id::text in (select row_id from kapchi_fixture.owned_rows where table_name='shipping_export_batches')) +
       (select count(*) from shipments where active_shipping_export_batch_id is not null
         and id::text in (select row_id from kapchi_fixture.owned_rows where table_name='shipments'))
     )::integer as count`,
  );
  if (activeExports) fail("FIXTURE_EXPORT_WORK_ELIGIBLE", "shipping_exports");

  const unattestedLiveMappings = await count(
    input.db,
    `select count(*) from listing_price_variants variants
      join listings listings on listings.id=variants.listing_id
      join kapchi_fixture.owned_rows owned on owned.table_name='listing_price_variants' and owned.row_id=variants.id::text
      left join kapchi_fixture.catalog_attestations attestations on attestations.fixture_key=owned.fixture_key
      where variants.active and variants.stripe_price_id not like 'price_local_seed_%'
        and (attestations.fixture_key is null or attestations.stripe_price_id<>variants.stripe_price_id
             or attestations.stripe_product_id<>variants.stripe_product_id or attestations.livemode)`,
  );
  if (unattestedLiveMappings) fail("FIXTURE_CATALOG_ATTESTATION_MISSING", "catalog_attestations");

  const operational = await verifyOperationalFixtures(
    input.db,
    operationalReferences(),
  );

  return {
    analytics: expected,
    event: "fixture.verify.completed",
    identities: fixtureIdentitiesCount(),
    operational,
    orders: orderCount,
    ownedRows: ownershipCount
  };
}

function fixtureIdentitiesCount() {
  return 6;
}
