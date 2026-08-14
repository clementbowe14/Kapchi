import process from "node:process";
import { Pool } from "pg";
import Stripe from "stripe";
import { loadBackendEnvironment } from "../config/load-environment.js";
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
    const result = await syncStripeTestCatalog({
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

main().catch((error: unknown) => {
  console.error(JSON.stringify(safeStripeCatalogSyncFailure(error)));
  process.exitCode = 1;
});
