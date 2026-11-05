import process from "node:process";
import { Pool } from "pg";
import Stripe from "stripe";
import { loadBackendEnvironment } from "../config/load-environment.js";
import {
  FIXTURE_ADVISORY_LOCK_KEY,
  FIXTURE_MARKER_ID
} from "../database/fixtures/admin-workflows.js";
import {
  assertInitializedFixtureDatabase,
  fingerprint
} from "../database/fixtures/safety.js";
import { seedListings } from "../database/seed.js";
import {
  assertStripeCatalogSyncSafe,
  safeStripeCatalogSyncFailure,
  syncStripeTestCatalog,
  type StripeCatalogClient
} from "../modules/payments/stripe-catalog-sync.js";

loadBackendEnvironment();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  assertStripeCatalogSyncSafe({
    databaseUrl,
    nodeEnv: process.env.NODE_ENV,
    stripeSecretKey
  });

  const stripe = new Stripe(stripeSecretKey!, {
    apiVersion: (process.env.STRIPE_API_VERSION ??
      "2026-02-25.clover") as Stripe.LatestApiVersion
  });
  const stripeCatalogClient: StripeCatalogClient = {
    accounts: {
      retrieve: async () => {
        const account = await stripe.accounts.retrieve();
        return { id: account.id };
      }
    },
    prices: {
      create: (params, options) => stripe.prices.create(params, options),
      list: (params) => stripe.prices.list(params),
      retrieve: (id) => stripe.prices.retrieve(id),
      update: (id, params, options) => stripe.prices.update(id, params, options)
    },
    products: {
      create: (params, options) => stripe.products.create(params, options),
      list: (params) => stripe.products.list(params),
      update: (id, params, options) => stripe.products.update(id, params, options)
    }
  };
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: Number(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000,
    ),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30000),
    max: 1
  });

  try {
    await assertInitializedFixtureDatabase({
      databaseUrl,
      db: pool,
      nodeEnv: process.env.NODE_ENV,
      token: process.env.KAPCHI_FIXTURE_DATABASE_TOKEN
    });
    const expectedOwnership = seedListings.reduce(
      (count, listing) => count + 1 + listing.priceVariants.length,
      0,
    );
    const ownership = await pool.query<{ count: number }>(
      `select count(*)::integer as count from kapchi_fixture.owned_rows
        where fixture_key = any($1::text[])`,
      [seedListings.flatMap((listing) => [
        `catalog.listing.${listing.slug}`,
        ...listing.priceVariants.map((variant) =>
          `catalog.variant.${listing.slug}.${variant.variantKey}`,
        )
      ])],
    );
    if (Number(ownership.rows[0]?.count ?? 0) !== expectedOwnership) {
      throw new Error("FIXTURE_CATALOG_OWNERSHIP_MISSING");
    }
    const result = await syncStripeTestCatalog({
      advisoryLockId: FIXTURE_ADVISORY_LOCK_KEY,
      beforeCommit: recordCatalogAttestations,
      database: pool,
      databaseUrl,
      nodeEnv: process.env.NODE_ENV,
      stripe: stripeCatalogClient,
      stripeSecretKey
    });
    console.log(
      JSON.stringify(
        {
          accountId: result.accountId,
          bindings: result.bindings,
          cartsReactivated: result.cartsReactivated,
          cleanupFailures: result.cleanupFailures,
          ordersRecovered: result.ordersRecovered,
          pricesCreated: result.pricesCreated,
          pricesProtected: result.pricesProtected,
          pricesReused: result.pricesReused,
          productsCreated: result.productsCreated,
          productsReused: result.productsReused
        },
        null,
        2,
      ),
    );
    if (result.cleanupFailures > 0) {
      console.warn(
        "Stripe catalog mappings committed, but one or more replaced Prices could not be deactivated. Re-run the command to retry safely.",
      );
    }
    if (result.pricesProtected > 0) {
      console.warn(
        "One or more replaced Prices remain active because unresolved checkout orders still reference them. Resolve those orders and re-run the command to retry cleanup.",
      );
    }
  } finally {
    await pool.end();
  }
}

export async function recordCatalogAttestations(
  client: Parameters<
    NonNullable<Parameters<typeof syncStripeTestCatalog>[0]["beforeCommit"]>
  >[0],
  result: Pick<
    Awaited<ReturnType<typeof syncStripeTestCatalog>>,
    "accountId" | "bindings"
  >,
) {
  for (const binding of result.bindings) {
    const listing = seedListings.find(
      (candidate) => candidate.slug === binding.slug,
    );
    if (!listing) throw new Error("FIXTURE_CATALOG_BINDING_UNKNOWN");
    for (const price of binding.prices) {
      const variant = listing.priceVariants.find(
        (candidate) => candidate.variantKey === price.variantKey,
      );
      if (!variant) throw new Error("FIXTURE_CATALOG_VARIANT_UNKNOWN");
      const persisted = await client.query<{
        stripe_price_id: string;
        stripe_product_id: string;
        unit_amount_cents: number;
      }>(
        `select variants.stripe_product_id, variants.stripe_price_id,
                  variants.unit_amount_cents
             from listing_price_variants variants
             join listings on listings.id=variants.listing_id
             join kapchi_fixture.owned_rows owned
               on owned.table_name='listing_price_variants'
              and owned.row_id=variants.id::text
            where listings.slug=$1 and variants.variant_key=$2 and variants.active
              and owned.fixture_key=$3`,
          [
            listing.slug,
            variant.variantKey,
            `catalog.variant.${listing.slug}.${variant.variantKey}`
          ],
      );
      const row = persisted.rows[0];
      if (
        !row ||
        row.stripe_product_id !== binding.productId ||
        row.stripe_price_id !== price.id ||
        row.unit_amount_cents !== variant.unitAmountCents
      ) {
        throw new Error("FIXTURE_CATALOG_BINDING_DRIFT");
      }
      const pricingFingerprint = fingerprint({
        active: true,
        currency: "usd",
        customizationKind: variant.customizationKind,
        listingSlug: listing.slug,
        unitAmountCents: variant.unitAmountCents,
        variantKey: variant.variantKey
      });
      await client.query(
        `insert into kapchi_fixture.catalog_attestations
             (fixture_key,marker_id,stripe_account_id,stripe_product_id,stripe_price_id,
              listing_slug,variant_key,customization_kind,unit_amount_cents,currency,
              pricing_fingerprint,livemode)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'usd',$10,false)
           on conflict (fixture_key) do update set
             marker_id=excluded.marker_id,stripe_account_id=excluded.stripe_account_id,
             stripe_product_id=excluded.stripe_product_id,stripe_price_id=excluded.stripe_price_id,
             listing_slug=excluded.listing_slug,variant_key=excluded.variant_key,
             customization_kind=excluded.customization_kind,
             unit_amount_cents=excluded.unit_amount_cents,currency=excluded.currency,
             pricing_fingerprint=excluded.pricing_fingerprint,livemode=false,attested_at=now()`,
          [
            `catalog.variant.${listing.slug}.${variant.variantKey}`,
            FIXTURE_MARKER_ID,
            result.accountId,
            binding.productId,
            price.id,
            listing.slug,
            variant.variantKey,
            variant.customizationKind,
            variant.unitAmountCents,
            pricingFingerprint
        ],
      );
    }
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify(safeStripeCatalogSyncFailure(error)));
    process.exitCode = 1;
  });
}
