import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import {
  seedListing,
  seedListings,
  type SeedListing
} from "../../database/seed.js";
import {
  buildStripePriceLookupKey,
  findProtectedReplacedPriceIds,
  recoverLocalPlaceholderOrders,
  stripeCatalogSyncAdvisoryLockId,
  syncStripeTestCatalog,
  type StripeCatalogClient,
  type StripeCatalogDatabase,
  type StripeCatalogDatabaseClient
} from "./stripe-catalog-sync.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type CatalogRow = {
  listing_id: string;
  listing_price_variant_id: string;
  unit_amount_cents: number;
};

integrationDescribe("Stripe local catalog recovery", () => {
  let client: PoolClient;
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("begin");
  });

  afterEach(async () => {
    await client.query("rollback");
    client.release();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("recovers only failed catalog orders whose carts can be reactivated", async () => {
    const catalog = await client.query<CatalogRow>(
      `
        select
          l.id as listing_id,
          lpv.id as listing_price_variant_id,
          lpv.unit_amount_cents
        from listings l
        join listing_price_variants lpv
          on lpv.listing_id = l.id and lpv.active = true
        where l.slug = $1 and lpv.variant_key = $2
        limit 1
      `,
      [seedListings[0].slug, seedListings[0].priceVariants[0].variantKey],
    );
    expect(catalog.rows).toHaveLength(1);
    const variant = catalog.rows[0];
    const cases = [
      { kind: "eligible", itemMode: "placeholder" },
      {
        kind: "has-session",
        itemMode: "placeholder",
        sessionId: `cs_test_${randomUUID()}`
      },
      { kind: "real-ids", itemMode: "real" },
      { kind: "mixed-items", itemMode: "mixed" },
      { kind: "crossed-placeholder", itemMode: "crossed" },
      { activeSibling: true, kind: "active-sibling", itemMode: "placeholder" },
      { expired: true, kind: "expired-cart", itemMode: "placeholder" },
      { competingOrder: true, kind: "competing-order", itemMode: "placeholder" },
      {
        eventType: "checkout.catalog_unavailable",
        kind: "real-catalog-event",
        itemMode: "real"
      },
      {
        eventType: "checkout.catalog_unavailable",
        kind: "mixed-catalog-event",
        itemMode: "mixed"
      },
      {
        eventType: "checkout.provider_failed",
        kind: "generic-provider-event",
        itemMode: "real"
      }
    ] as const;
    const records = new Map<string, { cartId: string; orderId: string }>();

    for (const testCase of cases) {
      const cartId = randomUUID();
      const orderId = randomUUID();
      records.set(testCase.kind, { cartId, orderId });
      const cartUserId = `stripe-sync-${testCase.kind}-${cartId}`;
      await client.query(
        `
          insert into carts (
            id, user_id, status, currency, subtotal_cents, expires_at
          ) values (
            $1, $2, 'checkout_started', 'usd', $3,
            case when $4 then now() - interval '1 hour' else now() + interval '1 hour' end
          )
        `,
        [
          cartId,
          cartUserId,
          variant.unit_amount_cents,
          "expired" in testCase && testCase.expired === true
        ],
      );
      if ("activeSibling" in testCase && testCase.activeSibling) {
        await client.query(
          `
            insert into carts (
              id, user_id, status, currency, subtotal_cents, expires_at
            ) values ($1, $2, 'active', 'usd', 0, now() + interval '1 hour')
          `,
          [randomUUID(), cartUserId],
        );
      }
      await client.query(
        `
          insert into orders (
            id, public_order_number, user_id, cart_id, status,
            payment_status, subtotal_cents, total_cents, currency,
            stripe_checkout_session_id
          ) values (
            $1, $2, $3, $4, 'pending_payment', 'failed', $5, $5, 'usd', $6
          )
        `,
        [
          orderId,
          `SYNC-${orderId}`,
          `stripe-sync-${testCase.kind}`,
          cartId,
          variant.unit_amount_cents,
          "sessionId" in testCase ? testCase.sessionId : null
        ],
      );
      if ("competingOrder" in testCase && testCase.competingOrder) {
        const competingOrderId = randomUUID();
        await client.query(
          `
            insert into orders (
              id, public_order_number, user_id, cart_id, status,
              payment_status, subtotal_cents, total_cents, currency
            ) values (
              $1, $2, $3, $4, 'pending_payment', 'checkout_started',
              $5, $5, 'usd'
            )
          `,
          [
            competingOrderId,
            `SYNC-${competingOrderId}`,
            `stripe-sync-${testCase.kind}`,
            cartId,
            variant.unit_amount_cents
          ],
        );
      }

      const itemModes = testCase.itemMode === "mixed"
        ? ["placeholder", "real"] as const
        : [testCase.itemMode] as const;
      for (const itemMode of itemModes) {
        await client.query(
          `
            insert into order_items (
              order_id, listing_id, listing_price_variant_id, quantity,
              unit_amount_cents, total_amount_cents, currency,
              stripe_product_id, stripe_price_id,
              listing_snapshot, customization_snapshot
            ) values (
              $1, $2, $3, 1, $4, $4, 'usd', $5, $6,
              $7::jsonb, '{}'::jsonb
            )
          `,
          [
            orderId,
            variant.listing_id,
            variant.listing_price_variant_id,
            variant.unit_amount_cents,
            itemMode === "placeholder"
              ? seedListings[0].stripeProductId
              : itemMode === "crossed"
                ? seedListings[1].stripeProductId
                : "prod_test_real_mapping",
            itemMode === "placeholder" || itemMode === "crossed"
              ? seedListings[0].priceVariants[0].stripePriceId
              : "price_test_real_mapping",
            JSON.stringify({ slug: seedListings[0].slug })
          ],
        );
      }
      if ("eventType" in testCase) {
        await client.query(
          `
            insert into order_events (
              order_id, actor_type, event_type, to_value, metadata
            ) values ($1, 'system', $2, 'failed', '{"source":"integration_test"}')
          `,
          [orderId, testCase.eventType],
        );
      }
    }

    const orderIds = [...records.values()].map((record) => record.orderId);
    const beforeItems = await client.query<{
      order_id: string;
      stripe_price_id: string;
      stripe_product_id: string;
    }>(
      `
        select order_id, stripe_price_id, stripe_product_id
        from order_items
        where order_id = any($1::uuid[])
        order by order_id, stripe_price_id
      `,
      [orderIds],
    );

    const recovered = await recoverLocalPlaceholderOrders(client);
    const recoveredKinds = [...records]
      .filter(([, record]) =>
        recovered.some((row) => row.order_id === record.orderId),
      )
      .map(([kind]) => kind);
    expect(recoveredKinds.sort()).toEqual([
      "eligible",
      "mixed-catalog-event",
      "real-catalog-event"
    ]);
    expect(recovered.every((row) => row.cart_reactivated === true)).toBe(true);

    const states = await client.query<{
      cart_status: string;
      id: string;
      order_status: string;
    }>(
      `
        select o.id, o.status as order_status, c.status as cart_status
        from orders o
        join carts c on c.id = o.cart_id
        where o.id = any($1::uuid[])
      `,
      [orderIds],
    );
    const recoveredSet = new Set(recovered.map((row) => row.order_id));
    for (const state of states.rows) {
      if (recoveredSet.has(state.id)) {
        expect(state).toMatchObject({
          cart_status: "active",
          order_status: "cancelled"
        });
      } else {
        expect(state).toMatchObject({
          cart_status: "checkout_started",
          order_status: "pending_payment"
        });
      }
    }

    const recoveryEvents = await client.query<{ order_id: string }>(
      `
        select order_id from order_events
        where order_id = any($1::uuid[])
          and event_type = 'checkout.catalog_mapping_recovered'
      `,
      [orderIds],
    );
    expect(new Set(recoveryEvents.rows.map((row) => row.order_id))).toEqual(
      recoveredSet,
    );

    const afterItems = await client.query<{
      order_id: string;
      stripe_price_id: string;
      stripe_product_id: string;
    }>(
      `
        select order_id, stripe_price_id, stripe_product_id
        from order_items
        where order_id = any($1::uuid[])
        order by order_id, stripe_price_id
      `,
      [orderIds],
    );
    expect(afterItems.rows).toEqual(beforeItems.rows);
  });

  it("preserves synchronized mappings only while the desired pricing identity matches", async () => {
    const listing = seedListings[0];
    const defaultVariant = listing.priceVariants[0];
    const suffix = randomUUID().replaceAll("-", "");
    const synchronizedProductId = `prod_test_seed_${suffix}`;
    const synchronizedPriceId = `price_test_seed_${suffix}`;

    await client.query(
      `
        update listings
        set base_price_cents = $2,
            currency = 'usd',
            stripe_product_id = $3,
            default_stripe_price_id = $4
        where slug = $1
      `,
      [
        listing.slug,
        listing.basePriceCents,
        synchronizedProductId,
        synchronizedPriceId
      ],
    );
    await client.query(
      `
        update listing_price_variants lpv
        set unit_amount_cents = $3,
            currency = 'usd',
            stripe_product_id = $4,
            stripe_price_id = $5
        from listings l
        where lpv.listing_id = l.id
          and l.slug = $1
          and lpv.variant_key = $2
          and lpv.active = true
      `,
      [
        listing.slug,
        defaultVariant.variantKey,
        defaultVariant.unitAmountCents,
        synchronizedProductId,
        synchronizedPriceId
      ],
    );

    await seedListing(client, listing);
    const preserved = await readDefaultBinding(client, listing);
    expect(preserved).toMatchObject({
      base_price_cents: listing.basePriceCents,
      currency: "usd",
      default_stripe_price_id: synchronizedPriceId,
      stripe_price_id: synchronizedPriceId,
      stripe_product_id: synchronizedProductId,
      unit_amount_cents: defaultVariant.unitAmountCents
    });

    const changedAmount = defaultVariant.unitAmountCents + 125;
    const changedListing: SeedListing = {
      ...listing,
      basePriceCents: changedAmount,
      priceVariants: listing.priceVariants.map((variant, index) => ({
        ...variant,
        unitAmountCents: index === 0 ? changedAmount : variant.unitAmountCents
      }))
    };
    await seedListing(client, changedListing);
    const amountDrift = await readDefaultBinding(client, changedListing);
    expect(amountDrift).toMatchObject({
      base_price_cents: changedAmount,
      currency: "usd",
      default_stripe_price_id: defaultVariant.stripePriceId,
      stripe_price_id: defaultVariant.stripePriceId,
      stripe_product_id: listing.stripeProductId,
      unit_amount_cents: changedAmount
    });

    const secondSuffix = randomUUID().replaceAll("-", "");
    const secondProductId = `prod_test_seed_${secondSuffix}`;
    const secondPriceId = `price_test_seed_${secondSuffix}`;
    await client.query(
      `
        update listings
        set currency = 'cad', stripe_product_id = $2, default_stripe_price_id = $3
        where slug = $1
      `,
      [listing.slug, secondProductId, secondPriceId],
    );
    await client.query(
      `
        update listing_price_variants lpv
        set currency = 'cad', stripe_product_id = $3, stripe_price_id = $4
        from listings l
        where lpv.listing_id = l.id
          and l.slug = $1
          and lpv.variant_key = $2
          and lpv.active = true
      `,
      [listing.slug, defaultVariant.variantKey, secondProductId, secondPriceId],
    );

    await seedListing(client, changedListing);
    const currencyDrift = await readDefaultBinding(client, changedListing);
    expect(currencyDrift).toMatchObject({
      currency: "usd",
      default_stripe_price_id: defaultVariant.stripePriceId,
      stripe_price_id: defaultVariant.stripePriceId,
      stripe_product_id: listing.stripeProductId,
      unit_amount_cents: changedAmount
    });
  });

  it("protects generic pending failures until their order becomes terminal", async () => {
    const catalog = await client.query<CatalogRow>(
      `
        select
          l.id as listing_id,
          lpv.id as listing_price_variant_id,
          lpv.unit_amount_cents
        from listings l
        join listing_price_variants lpv
          on lpv.listing_id = l.id and lpv.active = true
        where l.slug = $1 and lpv.variant_key = $2
      `,
      [seedListings[0].slug, seedListings[0].priceVariants[0].variantKey],
    );
    const variant = catalog.rows[0];
    expect(variant).toBeDefined();
    const cartId = randomUUID();
    const orderId = randomUUID();
    const predecessorPriceId = `price_test_predecessor_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `
        insert into carts (
          id, user_id, status, currency, subtotal_cents, expires_at
        ) values ($1, $2, 'checkout_started', 'usd', $3, now() + interval '1 hour')
      `,
      [cartId, `protected-price-${cartId}`, variant.unit_amount_cents],
    );
    await client.query(
      `
        insert into orders (
          id, public_order_number, user_id, cart_id, status,
          payment_status, subtotal_cents, total_cents, currency
        ) values (
          $1, $2, $3, $4, 'pending_payment', 'failed', $5, $5, 'usd'
        )
      `,
      [
        orderId,
        `SYNC-${orderId}`,
        `protected-price-${orderId}`,
        cartId,
        variant.unit_amount_cents
      ],
    );
    await client.query(
      `
        insert into order_items (
          order_id, listing_id, listing_price_variant_id, quantity,
          unit_amount_cents, total_amount_cents, currency,
          stripe_product_id, stripe_price_id,
          listing_snapshot, customization_snapshot
        ) values (
          $1, $2, $3, 1, $4, $4, 'usd', $5, $6,
          $7::jsonb, '{}'::jsonb
        )
      `,
      [
        orderId,
        variant.listing_id,
        variant.listing_price_variant_id,
        variant.unit_amount_cents,
        "prod_test_real_mapping",
        predecessorPriceId,
        JSON.stringify({ slug: seedListings[0].slug })
      ],
    );

    expect(
      await findProtectedReplacedPriceIds(client, [predecessorPriceId]),
    ).toEqual(new Set([predecessorPriceId]));
    expect(
      (await recoverLocalPlaceholderOrders(client)).some(
        (row) => row.order_id === orderId,
      ),
    ).toBe(false);

    await client.query(
      `update orders set status = 'cancelled', cancelled_at = now() where id = $1`,
      [orderId],
    );
    expect(
      await findProtectedReplacedPriceIds(client, [predecessorPriceId]),
    ).toEqual(new Set());
  });

  it("rolls back all mappings when a variant drifts after remote preparation", async () => {
    for (const listing of seedListings) await seedListing(client, listing);
    const before = await readCatalogMappings(client);
    const driftVariant = seedListings[0].priceVariants[1];
    const savepoint = "stripe_catalog_compare_and_set";
    let driftInjected = false;
    const database: StripeCatalogDatabase = {
      connect: async () => ({
        query: async <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          values: unknown[] = [],
        ) => {
          if (sql === "begin") {
            await client.query(`savepoint ${savepoint}`);
            await client.query(
              `
                update listing_price_variants lpv
                set unit_amount_cents = unit_amount_cents + 1
                from listings l
                where lpv.listing_id = l.id
                  and l.slug = $1
                  and lpv.variant_key = $2
                  and lpv.active = true
              `,
              [seedListings[0].slug, driftVariant.variantKey],
            );
            driftInjected = true;
            return { rows: [] as T[] };
          }
          if (sql === "rollback") {
            await client.query(`rollback to savepoint ${savepoint}`);
            await client.query(`release savepoint ${savepoint}`);
            return { rows: [] as T[] };
          }
          if (sql === "commit") {
            await client.query(`release savepoint ${savepoint}`);
            return { rows: [] as T[] };
          }
          const result = await client.query<T>(sql, values);
          return { rows: result.rows };
        },
        release: () => undefined
      } as StripeCatalogDatabaseClient)
    };

    await expect(
      syncStripeTestCatalog({
        database,
        databaseUrl: process.env.DATABASE_URL,
        nodeEnv: "test",
        stripe: createMatchingStripeCatalog(),
        stripeSecretKey: "sk_test_compare_and_set_integration"
      }),
    ).rejects.toThrow(
      `${driftVariant.variantKey} changed after Stripe preparation`,
    );

    expect(driftInjected).toBe(true);
    expect(await readCatalogMappings(client)).toEqual(before);
  });

  it("refuses a concurrent session lock without waiting or reaching Stripe", async () => {
    const accountsRetrieve = vi.fn(async () => ({ id: "acct_should_not_run" }));
    const unreachable = vi.fn(async () => {
      throw new Error("Stripe should not be called while the lock is held.");
    });
    const stripe = {
      accounts: { retrieve: accountsRetrieve },
      prices: {
        create: unreachable,
        list: unreachable,
        retrieve: unreachable,
        update: unreachable
      },
      products: {
        create: unreachable,
        list: unreachable,
        update: unreachable
      }
    } as unknown as StripeCatalogClient;

    await client.query("select pg_advisory_lock($1)", [
      stripeCatalogSyncAdvisoryLockId
    ]);
    try {
      const result = await Promise.race([
        syncStripeTestCatalog({
          database: pool,
          databaseUrl: process.env.DATABASE_URL,
          nodeEnv: "test",
          stripe,
          stripeSecretKey: "sk_test_lock_integration"
        }).catch((error: unknown) => error),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 500);
        })
      ]);

      expect(result).not.toBe("timeout");
      expect(result).toMatchObject({
        code: "STRIPE_CATALOG_SYNC_ALREADY_RUNNING"
      });
      expect(accountsRetrieve).not.toHaveBeenCalled();
    } finally {
      await client.query("select pg_advisory_unlock($1)", [
        stripeCatalogSyncAdvisoryLockId
      ]);
    }
  });
});

async function readDefaultBinding(client: PoolClient, listing: SeedListing) {
  const result = await client.query<{
    base_price_cents: number;
    currency: string;
    default_stripe_price_id: string;
    stripe_price_id: string;
    stripe_product_id: string;
    unit_amount_cents: number;
  }>(
    `
      select
        l.base_price_cents,
        l.currency,
        l.default_stripe_price_id,
        lpv.stripe_price_id,
        lpv.stripe_product_id,
        lpv.unit_amount_cents
      from listings l
      join listing_price_variants lpv
        on lpv.listing_id = l.id and lpv.active = true
      where l.slug = $1 and lpv.variant_key = $2
    `,
    [listing.slug, listing.priceVariants[0].variantKey],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function readCatalogMappings(client: PoolClient) {
  const result = await client.query<{
    currency: string;
    default_stripe_price_id: string | null;
    slug: string;
    stripe_price_id: string;
    stripe_product_id: string;
    unit_amount_cents: number;
    variant_key: string;
  }>(
    `
      select
        l.slug,
        l.default_stripe_price_id,
        lpv.variant_key,
        lpv.unit_amount_cents,
        lpv.currency,
        lpv.stripe_product_id,
        lpv.stripe_price_id
      from listings l
      join listing_price_variants lpv
        on lpv.listing_id = l.id and lpv.active = true
      where l.slug = any($1::text[])
      order by l.slug, lpv.variant_key
    `,
    [seedListings.map((listing) => listing.slug)],
  );
  return result.rows;
}

function createMatchingStripeCatalog(): StripeCatalogClient {
  const products = new Map(
    seedListings.map((listing, listingIndex) => [
      listing.slug,
      {
        active: true,
        description: listing.description,
        id: `prod_test_catalog_${listingIndex}`,
        livemode: false,
        metadata: {
          kapchi_catalog: "local_seed",
          kapchi_catalog_generation: "1",
          kapchi_catalog_version: "1",
          kapchi_listing_slug: listing.slug
        },
        name: listing.title
      }
    ]),
  );
  const prices = new Map(
    seedListings.flatMap((listing, listingIndex) =>
      listing.priceVariants.map((variant, variantIndex) => {
        const lookupKey = buildStripePriceLookupKey(
          listing.slug,
          variant.variantKey,
        );
        return [
          lookupKey,
          {
            active: true,
            currency: "usd",
            id: `price_test_catalog_${listingIndex}_${variantIndex}`,
            livemode: false,
            lookup_key: lookupKey,
            metadata: {
              kapchi_catalog: "local_seed",
              kapchi_catalog_version: "1",
              kapchi_listing_slug: listing.slug,
              kapchi_variant_key: variant.variantKey
            },
            product: `prod_test_catalog_${listingIndex}`,
            unit_amount: variant.unitAmountCents
          }
        ] as const;
      }),
    ),
  );
  const unreachable = async () => {
    throw new Error("Matching integration catalog should not require Stripe writes.");
  };

  return {
    accounts: {
      retrieve: async () => ({ id: "acct_test_compare_and_set" })
    },
    prices: {
      create: unreachable,
      list: async ({ lookup_keys: lookupKeys }) => ({
        data: (lookupKeys ?? []).flatMap((lookupKey) => {
          const price = prices.get(lookupKey);
          return price ? [price] : [];
        })
      }),
      retrieve: async (id) => {
        const price = [...prices.values()].find((candidate) => candidate.id === id);
        if (!price) throw new Error("Integration Price is missing.");
        return price;
      },
      update: unreachable
    },
    products: {
      create: unreachable,
      list: async ({ limit, starting_after: startingAfter }) => {
        const allProducts = [...products.values()];
        const startIndex = startingAfter
          ? allProducts.findIndex((product) => product.id === startingAfter) + 1
          : 0;
        const data = allProducts.slice(startIndex, startIndex + limit);
        return {
          data,
          has_more: startIndex + data.length < allProducts.length
        };
      },
      update: unreachable
    }
  } as StripeCatalogClient;
}
