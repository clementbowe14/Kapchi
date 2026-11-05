import { describe, expect, it, vi } from "vitest";
import { seedListings, type SeedListing } from "../../database/seed.js";
import {
  assertStripeCatalogSyncSafe,
  buildStripePriceLookupKey,
  safeStripeCatalogSyncFailure,
  syncStripeTestCatalog,
  type StripeCatalogClient,
  type StripeCatalogDatabase,
  type StripeCatalogDatabaseClient
} from "./stripe-catalog-sync.js";

const databaseUrl = "postgresql://kapchi:kapchi@localhost:5432/kapchi_test";
const stripeSecretKey = "sk_test_catalog_sync";

type FakeProduct = Awaited<
  ReturnType<StripeCatalogClient["products"]["create"]>
>;
type FakePrice = Awaited<ReturnType<StripeCatalogClient["prices"]["create"]>>;

function createDatabase(options: {
  driftListing?: boolean;
  driftVariantKey?: string;
  events?: string[];
  failMapping?: boolean;
  lockAcquired?: boolean;
  protectedPriceIds?: string[];
  recoveredOrders?: Array<{
    cart_id: string;
    cart_reactivated: boolean;
    order_id: string;
  }>;
} = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      options.events?.push(`db:${sql.trim()}`);

      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.lockAcquired ?? true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ released: true }] };
      }

      if (options.failMapping && sql.includes("update listings")) {
        throw new Error("database write failed");
      }
      if (sql.includes("returning l.id")) {
        if (options.driftListing) return { rows: [] };
        return { rows: [{ id: `listing-${values[0]}` }] };
      }
      if (sql.includes("returning lpv.id")) {
        if (options.driftVariantKey === values[1]) return { rows: [] };
        return { rows: [{ id: `variant-${values[1]}` }] };
      }
      if (sql.includes("eligible_orders as")) {
        return { rows: options.recoveredOrders ?? [] };
      }
      if (sql.includes("select distinct oi.stripe_price_id")) {
        return {
          rows: (options.protectedPriceIds ?? []).map((stripePriceId) => ({
            stripe_price_id: stripePriceId
          }))
        };
      }

      return { rows: [] };
    }),
    release: vi.fn()
  };
  const database: StripeCatalogDatabase = {
    connect: vi.fn(async () => client as unknown as StripeCatalogDatabaseClient)
  };

  return { client, database, queries };
}

function createStripe(options: {
  failPriceCreateAt?: number;
  livemodeProduct?: boolean;
  productPageSize?: number;
  updatePriceFails?: boolean;
} = {}) {
  const products = new Map<string, FakeProduct>();
  const allProducts: FakeProduct[] = [];
  const prices = new Map<string, FakePrice>();
  const allPrices: FakePrice[] = [];
  const priceCreateCache = new Map<string, FakePrice>();
  const productUpdateCache = new Map<string, FakeProduct>();
  let productSequence = 0;
  let priceSequence = 0;
  let priceCreateAttempts = 0;
  const events: string[] = [];

  const client: StripeCatalogClient = {
    accounts: {
      retrieve: vi.fn(async () => ({ id: "acct_test_kapchi" }))
    },
    prices: {
      create: vi.fn(async (params, requestOptions) => {
        priceCreateAttempts += 1;
        events.push(`price.create:${params.lookup_key}`);
        if (priceCreateAttempts === options.failPriceCreateAt) {
          throw new Error("remote price creation failed");
        }

        const cached = priceCreateCache.get(requestOptions.idempotencyKey);
        if (cached) {
          return { ...cached, metadata: { ...cached.metadata } };
        }

        const previous = prices.get(params.lookup_key);
        if (previous && params.transfer_lookup_key) {
          previous.lookup_key = null;
        }
        const created: FakePrice = {
          active: true,
          currency: params.currency,
          id: `price_test_${++priceSequence}`,
          livemode: false,
          lookup_key: params.lookup_key,
          metadata: params.metadata,
          product: params.product,
          unit_amount: params.unit_amount
        };
        prices.set(params.lookup_key, created);
        allPrices.push(created);
        priceCreateCache.set(requestOptions.idempotencyKey, {
          ...created,
          metadata: { ...created.metadata }
        });
        expect(requestOptions.idempotencyKey).toBeTruthy();
        return created;
      }),
      list: vi.fn(async ({ lookup_keys }: { lookup_keys?: string[] }) => ({
        data: (lookup_keys ?? []).flatMap((key) => {
          const price = prices.get(key);
          return price ? [price] : [];
        })
      })),
      retrieve: vi.fn(async (id) => {
        const price = allPrices.find((candidate) => candidate.id === id);
        if (!price) throw new Error("price not found");
        return price;
      }),
      update: vi.fn(async (id, params, requestOptions) => {
        events.push(`price.update:${id}`);
        if (options.updatePriceFails) {
          throw new Error("cleanup failed");
        }
        expect(params).toEqual({ active: false });
        expect(requestOptions.idempotencyKey).toBeTruthy();
        const price = allPrices.find((candidate) => candidate.id === id);
        if (price) price.active = false;
        return price ?? {
          active: false,
          currency: "usd",
          id,
          livemode: false,
          lookup_key: null,
          metadata: {},
          product: "prod_unknown",
          unit_amount: 0
        };
      })
    },
    products: {
      create: vi.fn(async (params, requestOptions) => {
        events.push(`product.create:${params.metadata.kapchi_listing_slug}`);
        const created: FakeProduct = {
          active: true,
          description: params.description,
          id: `prod_test_${++productSequence}`,
          livemode: options.livemodeProduct ?? false,
          metadata: params.metadata,
          name: params.name
        };
        products.set(params.metadata.kapchi_listing_slug, created);
        allProducts.push(created);
        expect(requestOptions.idempotencyKey).toBeTruthy();
        return created;
      }),
      list: vi.fn(async ({ limit, starting_after: startingAfter }) => {
        const startIndex = startingAfter
          ? allProducts.findIndex((product) => product.id === startingAfter) + 1
          : 0;
        const pageSize = Math.min(limit, options.productPageSize ?? limit);
        const data = allProducts.slice(startIndex, startIndex + pageSize);
        return {
          data,
          has_more: startIndex + data.length < allProducts.length
        };
      }),
      update: vi.fn(async (id, params, requestOptions) => {
        events.push(`product.update:${id}`);
        expect(requestOptions.idempotencyKey).toBeTruthy();
        const cached = productUpdateCache.get(requestOptions.idempotencyKey);
        if (cached) {
          return { ...cached, metadata: { ...cached.metadata } };
        }
        const product = allProducts.find((candidate) => candidate.id === id)!;
        Object.assign(product, params, { metadata: { ...params.metadata } });
        const response = { ...product, metadata: { ...product.metadata } };
        productUpdateCache.set(requestOptions.idempotencyKey, response);
        return response;
      })
    }
  };

  return {
    allPrices,
    allProducts,
    client,
    events,
    priceCreateCache,
    prices,
    products,
    productUpdateCache
  };
}

function syncInput(
  database: StripeCatalogDatabase,
  stripe: StripeCatalogClient,
  catalog = seedListings,
) {
  return {
    catalog,
    database,
    databaseUrl,
    nodeEnv: "development",
    stripe,
    stripeSecretKey
  } as const;
}

function catalogWithDefaultAmount(unitAmountCents: number): SeedListing[] {
  return seedListings.map((listing, listingIndex) => ({
    ...listing,
    basePriceCents: listingIndex === 0 ? unitAmountCents : listing.basePriceCents,
    priceVariants: listing.priceVariants.map((variant, variantIndex) => ({
      ...variant,
      unitAmountCents:
        listingIndex === 0 && variantIndex === 0
          ? unitAmountCents
          : variant.unitAmountCents
    }))
  }));
}

function catalogWithProductDescription(description: string): SeedListing[] {
  return seedListings.map((listing, index) => ({
    ...listing,
    description: index === 0 ? description : listing.description,
    priceVariants: listing.priceVariants.map((variant) => ({ ...variant }))
  }));
}

describe("assertStripeCatalogSyncSafe", () => {
  it.each([
    {
      expected: "NODE_ENV=production",
      input: { databaseUrl, nodeEnv: "production", stripeSecretKey }
    },
    {
      expected: "non-local database host",
      input: {
        databaseUrl: "postgresql://kapchi:kapchi@db.example.com/kapchi_test",
        nodeEnv: "development",
        stripeSecretKey
      }
    },
    {
      expected: "test-mode Stripe credential",
      input: { databaseUrl, nodeEnv: "development", stripeSecretKey: "sk_live_nope" }
    }
  ])("refuses unsafe configuration before provider access", ({ expected, input }) => {
    expect(() => assertStripeCatalogSyncSafe(input)).toThrow(expected);
  });

  it("formats CLI failures without exposing provider messages or credentials", () => {
    const providerError = Object.assign(
      new Error("No such price for sk_test_do_not_log_this"),
      { code: "resource_missing", name: "StripeInvalidRequestError" },
    );

    const failure = safeStripeCatalogSyncFailure(providerError);
    const serialized = JSON.stringify(failure);

    expect(failure).toEqual({
      error: "STRIPE_TEST_CATALOG_SYNC_FAILED",
      errorCode: "resource_missing",
      errorType: "StripeInvalidRequestError"
    });
    expect(serialized).not.toContain(providerError.message);
    expect(serialized).not.toContain("sk_test_do_not_log_this");
  });
});

describe("syncStripeTestCatalog", () => {
  it("provisions every local seed binding and commits them in one transaction", async () => {
    const stripe = createStripe();
    const database = createDatabase({
      recoveredOrders: [{
        cart_id: "cart-1",
        cart_reactivated: true,
        order_id: "order-1"
      }]
    });

    const result = await syncStripeTestCatalog(syncInput(database.database, stripe.client));

    expect(result).toMatchObject({
      accountId: "acct_test_kapchi",
      cartsReactivated: 1,
      cleanupFailures: 0,
      ordersRecovered: 1,
      pricesCreated: 6,
      pricesProtected: 0,
      pricesReused: 0,
      productsCreated: 2,
      productsReused: 0
    });
    expect(database.queries[0].sql).toContain("pg_try_advisory_lock");
    expect(database.queries.some(({ sql }) => sql === "begin")).toBe(true);
    expect(database.queries.some(({ sql }) => sql === "commit")).toBe(true);
    expect(database.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    expect(stripe.client.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.client.prices.create).toHaveBeenCalledTimes(6);
    expect(stripe.client.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup_key: buildStripePriceLookupKey(
          "local-seed-classic-graduation-stole",
          "blank",
        ),
        metadata: expect.objectContaining({
          kapchi_catalog: "local_seed",
          kapchi_listing_slug: "local-seed-classic-graduation-stole",
          kapchi_variant_key: "blank"
        }),
        unit_amount: 4500
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(database.queries.some(({ sql }) => sql.includes("update order_items"))).toBe(
      false,
    );
  });

  it("uses a caller-selected advisory lock for the full synchronization", async () => {
    const stripe = createStripe();
    const database = createDatabase();
    const advisoryLockId = 85_000_001;

    await syncStripeTestCatalog({
      ...syncInput(database.database, stripe.client),
      advisoryLockId
    });

    expect(database.queries[0].values).toEqual([advisoryLockId]);
    expect(database.queries.at(-1)?.values).toEqual([advisoryLockId]);
  });

  it("rolls back catalog mappings when the before-commit attestation fails", async () => {
    const stripe = createStripe();
    const database = createDatabase();
    const beforeCommit = vi.fn(async () => {
      throw new Error("attestation rejected");
    });

    await expect(
      syncStripeTestCatalog({
        ...syncInput(database.database, stripe.client),
        beforeCommit
      }),
    ).rejects.toThrow("attestation rejected");

    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(database.queries.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(database.queries.some(({ sql }) => sql === "commit")).toBe(false);
    expect(database.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("reuses products and prices on repeated synchronization", async () => {
    const stripe = createStripe();
    const firstDatabase = createDatabase();
    await syncStripeTestCatalog(syncInput(firstDatabase.database, stripe.client));
    const secondDatabase = createDatabase();

    const result = await syncStripeTestCatalog(syncInput(secondDatabase.database, stripe.client));

    expect(result).toMatchObject({
      pricesCreated: 0,
      pricesReused: 6,
      productsCreated: 0,
      productsReused: 2
    });
    expect(stripe.client.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.client.prices.create).toHaveBeenCalledTimes(6);
  });

  it("immediately reuses a paginated Product when desired fields change", async () => {
    const stripe = createStripe({ productPageSize: 1 });
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );
    const originalProductId = stripe.products.get(seedListings[0].slug)!.id;

    await syncStripeTestCatalog(
      syncInput(
        createDatabase().database,
        stripe.client,
        catalogWithProductDescription("Immediate rerun description"),
      ),
    );

    expect(stripe.client.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.client.products.update).toHaveBeenCalledTimes(1);
    expect(stripe.products.get(seedListings[0].slug)).toMatchObject({
      description: "Immediate rerun description",
      id: originalProductId,
      metadata: expect.objectContaining({ kapchi_catalog_generation: "2" })
    });
    expect(stripe.client.products.list).toHaveBeenCalledWith({
      limit: 100,
      starting_after: expect.any(String)
    });
    expect("search" in stripe.client.products).toBe(false);
  });

  it("rejects duplicate local Products discovered across List pages", async () => {
    const stripe = createStripe({ productPageSize: 1 });
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );
    const existing = stripe.products.get(seedListings[0].slug)!;
    stripe.allProducts.push({
      ...existing,
      id: "prod_test_duplicate",
      metadata: { ...existing.metadata }
    });

    await expect(
      syncStripeTestCatalog(syncInput(createDatabase().database, stripe.client)),
    ).rejects.toThrow(
      `multiple local seed Products for ${seedListings[0].slug}`,
    );
  });

  it("uses a new idempotency generation across A to B to A to B price changes", async () => {
    const stripe = createStripe();
    const lookupKey = buildStripePriceLookupKey(
      seedListings[0].slug,
      seedListings[0].priceVariants[0].variantKey,
    );
    const selectedPriceIds: string[] = [];

    const amounts = Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0 ? 4500 : 4600,
    );
    for (const amount of amounts) {
      const database = createDatabase();
      const result = await syncStripeTestCatalog(
        syncInput(
          database.database,
          stripe.client,
          catalogWithDefaultAmount(amount),
        ),
      );
      selectedPriceIds.push(
        result.bindings[0].prices.find((price) => price.lookupKey === lookupKey)!.id,
      );
    }

    expect(new Set(selectedPriceIds)).toHaveLength(amounts.length);
    expect(stripe.priceCreateCache.size).toBe(6 + amounts.length - 1);
    const generations = stripe.allPrices.filter(
      (price) => price.metadata.kapchi_variant_key === "blank" &&
        price.metadata.kapchi_listing_slug === seedListings[0].slug,
    );
    expect(generations).toHaveLength(amounts.length);
    expect(generations.at(-1)).toMatchObject({ active: true, unit_amount: 4600 });
    expect(generations.slice(0, -1).every((price) => price.active === false)).toBe(
      true,
    );
    expect(generations[0].metadata.kapchi_replaced_price_id).toBeUndefined();
    for (let index = 1; index < generations.length; index += 1) {
      expect(generations[index].metadata).toMatchObject({
        kapchi_replaced_price_id: generations[index - 1].id
      });
      expect(generations[index].metadata.kapchi_replaced_price_ids).toBeUndefined();
      expect(generations[index].metadata.kapchi_replaced_price_id.length).toBeLessThan(
        500,
      );
    }
  });

  it("reads and deduplicates legacy plural predecessor metadata", async () => {
    const stripe = createStripe();
    for (const amount of [4500, 4600, 4500]) {
      await syncStripeTestCatalog(
        syncInput(
          createDatabase().database,
          stripe.client,
          catalogWithDefaultAmount(amount),
        ),
      );
    }
    const generations = stripe.allPrices.filter(
      (price) =>
        price.metadata.kapchi_listing_slug === seedListings[0].slug &&
        price.metadata.kapchi_variant_key === "blank",
    );
    const [first, second, selected] = generations;
    selected.metadata.kapchi_replaced_price_ids = `${second.id},${first.id}`;
    delete selected.metadata.kapchi_replaced_price_id;
    first.active = true;
    second.active = true;

    const result = await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );

    expect(result).toMatchObject({ cleanupFailures: 0, pricesReused: 6 });
    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    expect(
      vi.mocked(stripe.client.prices.retrieve).mock.calls.filter(
        ([id]) => id === first.id,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("rejects invalid and cyclic predecessor links before database writes", async () => {
    const invalidStripe = createStripe();
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, invalidStripe.client),
    );
    invalidStripe.prices.get(
      buildStripePriceLookupKey(seedListings[0].slug, "blank"),
    )!.metadata.kapchi_replaced_price_id = "invalid-price-id";
    const invalidDatabase = createDatabase();
    await expect(
      syncStripeTestCatalog(syncInput(invalidDatabase.database, invalidStripe.client)),
    ).rejects.toThrow("invalid predecessor link");
    expect(invalidDatabase.queries.some(({ sql }) => sql === "begin")).toBe(false);

    const invalidSelected = invalidStripe.prices.get(
      buildStripePriceLookupKey(seedListings[0].slug, "blank"),
    )!;
    invalidSelected.metadata.kapchi_replaced_price_id = invalidSelected.id;
    await expect(
      syncStripeTestCatalog(
        syncInput(createDatabase().database, invalidStripe.client),
      ),
    ).rejects.toThrow("non-advancing predecessor link");

    const cyclicStripe = createStripe();
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, cyclicStripe.client),
    );
    const lookupKey = buildStripePriceLookupKey(seedListings[0].slug, "blank");
    const first = cyclicStripe.prices.get(lookupKey)!;
    first.unit_amount = 1;
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, cyclicStripe.client),
    );
    const selected = cyclicStripe.prices.get(lookupKey)!;
    first.metadata.kapchi_replaced_price_id = selected.id;
    const cycleDatabase = createDatabase();
    await expect(
      syncStripeTestCatalog(syncInput(cycleDatabase.database, cyclicStripe.client)),
    ).rejects.toThrow("contains a cycle");
    expect(cycleDatabase.queries.some(({ sql }) => sql === "begin")).toBe(false);
  });

  it("rejects live or wrong-owner ancestors", async () => {
    for (const mutation of ["live", "wrong-owner"] as const) {
      const stripe = createStripe();
      await syncStripeTestCatalog(
        syncInput(createDatabase().database, stripe.client),
      );
      const lookupKey = buildStripePriceLookupKey(seedListings[0].slug, "blank");
      const ancestor = stripe.prices.get(lookupKey)!;
      ancestor.unit_amount = 1;
      await syncStripeTestCatalog(
        syncInput(createDatabase().database, stripe.client),
      );
      if (mutation === "live") ancestor.livemode = true;
      else ancestor.metadata.kapchi_variant_key = "text-short";

      const database = createDatabase();
      await expect(
        syncStripeTestCatalog(syncInput(database.database, stripe.client)),
      ).rejects.toThrow(
        mutation === "live" ? "livemode=false" : "is not owned by",
      );
      expect(database.queries.some(({ sql }) => sql === "begin")).toBe(false);
    }
  });

  it("uses a monotonic Product generation across A to B to A to B updates", async () => {
    const stripe = createStripe();
    const descriptions = ["Description A", "Description B", "Description A", "Description B"];

    for (const description of descriptions) {
      await syncStripeTestCatalog(
        syncInput(
          createDatabase().database,
          stripe.client,
          catalogWithProductDescription(description),
        ),
      );
    }

    const product = stripe.products.get(seedListings[0].slug)!;
    expect(product.description).toBe("Description B");
    expect(product.metadata.kapchi_catalog_generation).toBe("4");
    expect(stripe.client.products.update).toHaveBeenCalledTimes(3);
    expect(stripe.productUpdateCache.size).toBe(3);
    expect(
      vi.mocked(stripe.client.products.update).mock.calls.map(
        ([, params]) => params.metadata.kapchi_catalog_generation,
      ),
    ).toEqual(["2", "3", "4"]);
  });

  it("refuses a concurrent sync immediately before any Stripe access", async () => {
    const stripe = createStripe();
    const database = createDatabase({ lockAcquired: false });

    await expect(
      syncStripeTestCatalog(syncInput(database.database, stripe.client)),
    ).rejects.toMatchObject({
      code: "STRIPE_CATALOG_SYNC_ALREADY_RUNNING",
      name: "StripeCatalogSyncAlreadyRunningError"
    });

    expect(stripe.client.accounts.retrieve).not.toHaveBeenCalled();
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].sql).toContain("pg_try_advisory_lock");
    expect(database.client.release).toHaveBeenCalledOnce();
  });

  it("refuses catalog entries outside the canonical local seed scope", async () => {
    const stripe = createStripe();
    const database = createDatabase();
    const unsafeCatalog = catalogWithDefaultAmount(4500);
    unsafeCatalog[0] = { ...unsafeCatalog[0], slug: "unowned-listing" };

    await expect(
      syncStripeTestCatalog(
        syncInput(database.database, stripe.client, unsafeCatalog),
      ),
    ).rejects.toThrow("only on local seed listings");

    expect(database.database.connect).not.toHaveBeenCalled();
    expect(stripe.client.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("does not open the database transaction after a partial remote failure", async () => {
    const stripe = createStripe({ failPriceCreateAt: 2 });
    const database = createDatabase({ events: stripe.events });

    await expect(
      syncStripeTestCatalog(syncInput(database.database, stripe.client)),
    ).rejects.toThrow("remote price creation failed");

    expect(database.database.connect).toHaveBeenCalledOnce();
    expect(database.queries.some(({ sql }) => sql === "begin")).toBe(false);
    expect(database.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("rolls back database failures and can reuse prepared resources on retry", async () => {
    const stripe = createStripe();
    const failingDatabase = createDatabase({ failMapping: true });

    await expect(
      syncStripeTestCatalog(syncInput(failingDatabase.database, stripe.client)),
    ).rejects.toThrow("database write failed");
    expect(failingDatabase.queries.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(failingDatabase.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    expect(stripe.client.prices.update).not.toHaveBeenCalled();

    const retryDatabase = createDatabase();
    const result = await syncStripeTestCatalog(
      syncInput(retryDatabase.database, stripe.client),
    );

    expect(result.pricesReused).toBe(6);
    expect(retryDatabase.queries.some(({ sql }) => sql === "commit")).toBe(true);
  });

  it("replaces changed amounts and cleans up the old price only after commit", async () => {
    const stripe = createStripe();
    const firstDatabase = createDatabase();
    await syncStripeTestCatalog(syncInput(firstDatabase.database, stripe.client));
    const lookupKey = buildStripePriceLookupKey(
      seedListings[0].slug,
      seedListings[0].priceVariants[0].variantKey,
    );
    const oldPrice = stripe.prices.get(lookupKey)!;
    oldPrice.unit_amount = 1;
    const database = createDatabase({ events: stripe.events });

    const result = await syncStripeTestCatalog(syncInput(database.database, stripe.client));

    expect(result.pricesCreated).toBe(1);
    expect(stripe.client.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        unit_amount: 4500
      }),
      expect.anything(),
    );
    const commitIndex = stripe.events.findIndex((event) => event === "db:commit");
    const cleanupIndex = stripe.events.findIndex(
      (event) => event === `price.update:${oldPrice.id}`,
    );
    const unlockIndex = stripe.events.findIndex((event) =>
      event.includes("pg_advisory_unlock"),
    );
    expect(commitIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(commitIndex);
    expect(unlockIndex).toBeGreaterThan(cleanupIndex);
    expect(stripe.client.prices.retrieve).toHaveBeenCalledWith(oldPrice.id);
    expect(
      vi.mocked(stripe.client.prices.list).mock.calls.every(
        ([params]) => params.lookup_keys !== undefined,
      ),
    ).toBe(true);
  });

  it("protects predecessor Prices used by unresolved generic failures and retries later", async () => {
    const stripe = createStripe();
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );
    const lookupKey = buildStripePriceLookupKey(
      seedListings[0].slug,
      seedListings[0].priceVariants[0].variantKey,
    );
    const predecessor = stripe.prices.get(lookupKey)!;
    predecessor.unit_amount = 1;
    const protectedDatabase = createDatabase({
      protectedPriceIds: [predecessor.id]
    });

    const protectedResult = await syncStripeTestCatalog(
      syncInput(protectedDatabase.database, stripe.client),
    );

    expect(protectedResult).toMatchObject({
      cleanupFailures: 0,
      pricesCreated: 1,
      pricesProtected: 1
    });
    expect(predecessor.active).toBe(true);
    expect(stripe.client.prices.update).not.toHaveBeenCalledWith(
      predecessor.id,
      expect.anything(),
      expect.anything(),
    );
    const protectionQuery = protectedDatabase.queries.find(({ sql }) =>
      sql.includes("select distinct oi.stripe_price_id"),
    );
    expect(protectionQuery?.sql).toContain("o.status = 'pending_payment'");
    expect(protectionQuery?.sql).toContain(
      "o.stripe_checkout_session_id is null",
    );
    expect(protectionQuery?.sql).toContain("checkout.catalog_unavailable");
    expect(protectionQuery?.values).toEqual([[predecessor.id]]);
    expect(
      protectedDatabase.queries.findIndex(({ sql }) =>
        sql.includes("select distinct oi.stripe_price_id"),
      ),
    ).toBeLessThan(
      protectedDatabase.queries.findIndex(({ sql }) => sql === "commit"),
    );

    const middlePrice = stripe.prices.get(lookupKey)!;
    middlePrice.unit_amount = 2;
    const secondProtectedResult = await syncStripeTestCatalog(
      syncInput(
        createDatabase({ protectedPriceIds: [predecessor.id] }).database,
        stripe.client,
      ),
    );
    expect(secondProtectedResult).toMatchObject({
      pricesCreated: 1,
      pricesProtected: 1
    });
    expect(predecessor.active).toBe(true);
    expect(middlePrice.active).toBe(false);

    const retryResult = await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );
    expect(retryResult).toMatchObject({
      pricesCreated: 0,
      pricesProtected: 0
    });
    expect(predecessor.active).toBe(false);
    expect(stripe.client.prices.retrieve).toHaveBeenCalledWith(predecessor.id);
  });

  it("retries explicit predecessor cleanup after a mapping rollback", async () => {
    const stripe = createStripe();
    await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );
    const lookupKey = buildStripePriceLookupKey(
      seedListings[0].slug,
      seedListings[0].priceVariants[0].variantKey,
    );
    const predecessor = stripe.prices.get(lookupKey)!;
    predecessor.unit_amount = 1;

    await expect(
      syncStripeTestCatalog(
        syncInput(createDatabase({ failMapping: true }).database, stripe.client),
      ),
    ).rejects.toThrow("database write failed");
    expect(predecessor.active).toBe(true);

    const result = await syncStripeTestCatalog(
      syncInput(createDatabase().database, stripe.client),
    );

    expect(result.pricesReused).toBe(6);
    expect(predecessor.active).toBe(false);
    expect(stripe.client.prices.retrieve).toHaveBeenCalledWith(predecessor.id);
  });

  it("treats cleanup as best effort after durable mappings commit", async () => {
    const stripe = createStripe({ updatePriceFails: true });
    const firstDatabase = createDatabase();
    await syncStripeTestCatalog(syncInput(firstDatabase.database, stripe.client));
    const lookupKey = buildStripePriceLookupKey(
      seedListings[0].slug,
      seedListings[0].priceVariants[0].variantKey,
    );
    stripe.prices.get(lookupKey)!.unit_amount = 1;
    const database = createDatabase();

    const result = await syncStripeTestCatalog(syncInput(database.database, stripe.client));

    expect(database.queries.some(({ sql }) => sql === "commit")).toBe(true);
    expect(result.cleanupFailures).toBe(1);
  });

  it("rolls back when listing pricing drifts after remote preparation", async () => {
    const stripe = createStripe();
    const database = createDatabase({ driftListing: true });

    await expect(
      syncStripeTestCatalog(syncInput(database.database, stripe.client)),
    ).rejects.toThrow("changed after Stripe preparation");

    const listingMapping = database.queries.find(({ sql }) =>
      sql.includes("update listings l") && sql.includes("returning l.id"),
    );
    expect(listingMapping?.sql).toContain("l.base_price_cents = $4");
    expect(listingMapping?.sql).toContain("l.currency = $5");
    expect(listingMapping?.sql).toContain("default_variant.variant_key = $6");
    expect(listingMapping?.sql).toContain(
      "default_variant.unit_amount_cents = $7",
    );
    expect(listingMapping?.values.slice(3)).toEqual([
      seedListings[0].basePriceCents,
      "usd",
      seedListings[0].priceVariants[0].variantKey,
      seedListings[0].priceVariants[0].unitAmountCents,
      "usd"
    ]);
    expect(database.queries.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(stripe.client.prices.update).not.toHaveBeenCalled();
  });

  it("rolls back when a variant price drifts after remote preparation", async () => {
    const stripe = createStripe();
    const database = createDatabase({ driftVariantKey: "text-short" });

    await expect(
      syncStripeTestCatalog(syncInput(database.database, stripe.client)),
    ).rejects.toThrow("text-short changed after Stripe preparation");

    const variantMapping = database.queries.find(
      ({ sql, values }) =>
        sql.includes("returning lpv.id") && values[1] === "text-short",
    );
    expect(variantMapping?.sql).toContain("lpv.unit_amount_cents = $5");
    expect(variantMapping?.sql).toContain("lpv.currency = $6");
    expect(variantMapping?.values.slice(4)).toEqual([5000, "usd"]);
    expect(database.queries.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(stripe.client.prices.update).not.toHaveBeenCalled();
  });

  it("rejects live resources returned through a purported test client", async () => {
    const stripe = createStripe({ livemodeProduct: true });
    const database = createDatabase();

    await expect(
      syncStripeTestCatalog(syncInput(database.database, stripe.client)),
    ).rejects.toThrow("livemode=false");
    expect(database.database.connect).toHaveBeenCalledOnce();
    expect(database.queries.some(({ sql }) => sql === "begin")).toBe(false);
  });

  it("uses narrow recovery predicates and known placeholder identifiers", async () => {
    const stripe = createStripe();
    const database = createDatabase();

    await syncStripeTestCatalog(syncInput(database.database, stripe.client));

    const recovery = database.queries.find(({ sql }) =>
      sql.includes("eligible_orders as"),
    );
    expect(recovery?.sql).toContain("o.status = 'pending_payment'");
    expect(recovery?.sql).toContain("o.payment_status = 'failed'");
    expect(recovery?.sql).toContain("o.stripe_checkout_session_id is null");
    expect(recovery?.sql).toContain("checkout.catalog_unavailable");
    expect(recovery?.sql).toContain("not exists");
    expect(recovery?.sql).toContain("other.id <> o.id");
    expect(recovery?.sql).toContain("competing_cart.status = 'active'");
    expect(recovery?.sql).toContain("c.expires_at is null or c.expires_at > now()");
    expect(recovery?.sql.indexOf("c.expires_at is null")).toBeLessThan(
      recovery?.sql.indexOf("update orders") ?? 0,
    );
    expect(recovery?.values).toEqual([
      seedListings.map((listing) => listing.slug),
      seedListings.flatMap((listing) =>
        listing.priceVariants.map(() => listing.slug),
      ),
      seedListings.flatMap((listing) =>
        listing.priceVariants.map(() => listing.stripeProductId),
      ),
      seedListings.flatMap((listing) =>
        listing.priceVariants.map((variant) => variant.stripePriceId),
      )
    ]);
  });
});
