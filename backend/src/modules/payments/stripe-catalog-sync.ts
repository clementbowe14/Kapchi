import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  assertSafeLocalSeedTarget,
  seedListings,
  type SeedListing
} from "../../database/seed.js";
import { safeErrorDetails } from "../../observability/safe-error.js";

const catalogMarker = "local_seed";
const catalogVersion = "1";
export const stripeCatalogSyncAdvisoryLockId = 1_579_412_789;
const productGenerationMetadataKey = "kapchi_catalog_generation";
const predecessorPriceIdMetadataKey = "kapchi_replaced_price_id";
const legacyPredecessorPriceIdsMetadataKey = "kapchi_replaced_price_ids";
const maxPricePredecessors = 256;
const stripeMetadataValueMaxLength = 500;
const testStripeKeyPattern = /^(?:rk|sk)_test_/;
const stripePriceIdPattern = /^price_[A-Za-z0-9_]+$/;

type StripeRequestOptions = { idempotencyKey: string };
type StripeMetadata = Record<string, string>;

export type StripeCatalogProduct = {
  active: boolean;
  description?: string | null;
  id: string;
  livemode: boolean;
  metadata: StripeMetadata;
  name: string;
};

export type StripeCatalogPrice = {
  active: boolean;
  currency: string;
  id: string;
  livemode: boolean;
  lookup_key: string | null;
  metadata: StripeMetadata;
  product: string | { id: string };
  unit_amount: number | null;
};

export type StripeCatalogClient = {
  accounts: {
    retrieve(): Promise<{ id: string }>;
  };
  prices: {
    create(
      params: {
        active: true;
        currency: string;
        lookup_key: string;
        metadata: StripeMetadata;
        nickname: string;
        product: string;
        transfer_lookup_key: boolean;
        unit_amount: number;
      },
      options: StripeRequestOptions,
    ): Promise<StripeCatalogPrice>;
    list(params: {
      limit: number;
      lookup_keys?: string[];
    }): Promise<{ data: StripeCatalogPrice[] }>;
    retrieve(id: string): Promise<StripeCatalogPrice>;
    update(
      id: string,
      params: { active: false },
      options: StripeRequestOptions,
    ): Promise<StripeCatalogPrice>;
  };
  products: {
    create(
      params: {
        active: true;
        description: string;
        metadata: StripeMetadata;
        name: string;
        shippable: true;
      },
      options: StripeRequestOptions,
    ): Promise<StripeCatalogProduct>;
    list(params: {
      limit: number;
      starting_after?: string;
    }): Promise<{ data: StripeCatalogProduct[]; has_more: boolean }>;
    update(
      id: string,
      params: {
        active: true;
        description: string;
        metadata: StripeMetadata;
        name: string;
      },
      options: StripeRequestOptions,
    ): Promise<StripeCatalogProduct>;
  };
};

export type StripeCatalogDatabase = {
  connect(): Promise<StripeCatalogDatabaseClient>;
};

export type StripeCatalogDatabaseClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(error?: Error): void;
};

export type StripeCatalogSyncInput = {
  catalog?: readonly SeedListing[];
  database: StripeCatalogDatabase;
  databaseUrl: string | undefined;
  nodeEnv: string | undefined;
  stripe: StripeCatalogClient;
  stripeSecretKey: string | undefined;
};

type PreparedPrice = {
  created: boolean;
  expectedCurrency: string;
  expectedUnitAmountCents: number;
  id: string;
  lookupKey: string;
  replacedPriceIds: string[];
  variantKey: string;
};

type PreparedListing = {
  created: boolean;
  defaultVariantKey: string;
  expectedBasePriceCents: number;
  expectedCurrency: string;
  prices: PreparedPrice[];
  productId: string;
  slug: string;
};

type RecoveredOrderRow = QueryResultRow & {
  cart_id: string | null;
  cart_reactivated: boolean;
  order_id: string;
};

type ProtectedPriceRow = QueryResultRow & {
  stripe_price_id: string;
};

export type StripeCatalogSyncResult = {
  accountId: string;
  bindings: Array<{
    prices: Array<{ id: string; lookupKey: string; variantKey: string }>;
    productId: string;
    slug: string;
  }>;
  cartsReactivated: number;
  cleanupFailures: number;
  ordersRecovered: number;
  pricesProtected: number;
  pricesCreated: number;
  pricesReused: number;
  productsCreated: number;
  productsReused: number;
};

export class StripeCatalogSyncAlreadyRunningError extends Error {
  readonly code = "STRIPE_CATALOG_SYNC_ALREADY_RUNNING";

  constructor() {
    super("A Stripe local catalog sync is already running.");
    this.name = "StripeCatalogSyncAlreadyRunningError";
  }
}

export function safeStripeCatalogSyncFailure(error: unknown) {
  return {
    error: "STRIPE_TEST_CATALOG_SYNC_FAILED",
    ...safeErrorDetails(error)
  };
}

export function assertStripeCatalogSyncSafe({
  databaseUrl,
  nodeEnv,
  stripeSecretKey
}: Pick<
  StripeCatalogSyncInput,
  "databaseUrl" | "nodeEnv" | "stripeSecretKey"
>) {
  assertSafeLocalSeedTarget(databaseUrl, nodeEnv ?? "development");

  if (!stripeSecretKey || !testStripeKeyPattern.test(stripeSecretKey)) {
    throw new Error(
      "Stripe catalog sync requires a test-mode Stripe credential (sk_test_ or rk_test_).",
    );
  }
}

function assertLocalSeedCatalog(catalog: readonly SeedListing[]) {
  const expected = seedListings.flatMap((listing) =>
    listing.priceVariants.map((variant) => `${listing.slug}/${variant.variantKey}`),
  ).sort();
  const received = catalog.flatMap((listing) =>
    listing.priceVariants.map((variant) => `${listing.slug}/${variant.variantKey}`),
  ).sort();

  if (
    expected.length !== received.length ||
    expected.some((identity, index) => identity !== received[index])
  ) {
    throw new Error("Stripe catalog sync may operate only on local seed listings.");
  }
}

function normalizedKeyPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function buildStripePriceLookupKey(slug: string, variantKey: string) {
  return `kapchi_local_${normalizedKeyPart(slug)}_${normalizedKeyPart(variantKey)}`;
}

function idempotencyKey(scope: string, identity: unknown) {
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
  return `kapchi-local-catalog:${scope}:${digest}`;
}

function catalogMetadata(slug: string): StripeMetadata {
  return {
    kapchi_catalog: catalogMarker,
    kapchi_catalog_version: catalogVersion,
    kapchi_listing_slug: slug
  };
}

function productMetadata(slug: string, generation: number): StripeMetadata {
  return {
    ...catalogMetadata(slug),
    [productGenerationMetadataKey]: String(generation)
  };
}

function priceMetadata(
  slug: string,
  variantKey: string,
  predecessorPriceId?: string,
): StripeMetadata {
  const metadata: StripeMetadata = {
    ...catalogMetadata(slug),
    kapchi_variant_key: variantKey
  };

  if (predecessorPriceId) {
    if (
      predecessorPriceId.length > stripeMetadataValueMaxLength ||
      !stripePriceIdPattern.test(predecessorPriceId)
    ) {
      throw new Error("Stripe Price has an invalid immediate predecessor ID.");
    }
    metadata[predecessorPriceIdMetadataKey] = predecessorPriceId;
  }

  return metadata;
}

function productGeneration(product: StripeCatalogProduct) {
  const rawGeneration = product.metadata[productGenerationMetadataKey];
  if (rawGeneration === undefined) return 0;
  if (!/^\d+$/.test(rawGeneration)) {
    throw new Error(`Stripe Product ${product.id} has an invalid catalog generation.`);
  }

  const generation = Number(rawGeneration);
  if (!Number.isSafeInteger(generation)) {
    throw new Error(`Stripe Product ${product.id} has an invalid catalog generation.`);
  }
  return generation;
}

function predecessorLinks(price: StripeCatalogPrice) {
  const links: string[] = [];
  const immediate = price.metadata[predecessorPriceIdMetadataKey];
  if (immediate !== undefined) links.push(immediate);

  const legacy = price.metadata[legacyPredecessorPriceIdsMetadataKey];
  if (legacy !== undefined) links.push(...legacy.split(","));

  for (const link of links) {
    if (
      link.length > stripeMetadataValueMaxLength ||
      !stripePriceIdPattern.test(link)
    ) {
      throw new Error(`Stripe Price ${price.id} has an invalid predecessor link.`);
    }
    if (link === price.id) {
      throw new Error(`Stripe Price ${price.id} has a non-advancing predecessor link.`);
    }
  }
  return [...new Set(links)];
}

function assertOwnedLocalSeedPrice(
  price: StripeCatalogPrice,
  slug: string,
  variantKey: string,
) {
  assertTestResource(price, "Price");
  if (
    price.metadata.kapchi_catalog !== catalogMarker ||
    price.metadata.kapchi_listing_slug !== slug ||
    price.metadata.kapchi_variant_key !== variantKey
  ) {
    throw new Error(
      `Stripe Price ${price.id} is not owned by ${slug}/${variantKey}.`,
    );
  }
}

async function resolvePricePredecessors(
  stripe: StripeCatalogClient,
  root: StripeCatalogPrice,
  slug: string,
  variantKey: string,
) {
  const resolved = new Map<string, StripeCatalogPrice>();
  const visiting = new Set<string>([root.id]);
  const visited = new Set<string>();

  async function visit(price: StripeCatalogPrice): Promise<void> {
    for (const predecessorId of predecessorLinks(price)) {
      if (visiting.has(predecessorId)) {
        throw new Error(
          `Stripe Price predecessor chain for ${slug}/${variantKey} contains a cycle.`,
        );
      }
      if (visited.has(predecessorId)) continue;
      if (resolved.size >= maxPricePredecessors) {
        throw new Error(
          `Stripe Price predecessor chain for ${slug}/${variantKey} is too long.`,
        );
      }

      const predecessor = await stripe.prices.retrieve(predecessorId);
      assertOwnedLocalSeedPrice(predecessor, slug, variantKey);
      resolved.set(predecessorId, predecessor);
      visiting.add(predecessorId);
      await visit(predecessor);
      visiting.delete(predecessorId);
      visited.add(predecessorId);
    }
  }

  await visit(root);
  return [...resolved.keys()];
}

function assertTestResource(
  resource: { id: string; livemode: boolean },
  kind: "Price" | "Product",
) {
  if (resource.livemode !== false) {
    throw new Error(`Stripe ${kind} ${resource.id} must have livemode=false.`);
  }
}

function productId(value: StripeCatalogPrice["product"]) {
  return typeof value === "string" ? value : value.id;
}

function productMatches(
  product: StripeCatalogProduct,
  listing: SeedListing,
  expectedGeneration?: number,
) {
  const metadata = catalogMetadata(listing.slug);
  return (
    product.active &&
    product.name === listing.title &&
    product.description === listing.description &&
    Object.entries(metadata).every(([key, value]) => product.metadata[key] === value) &&
    (expectedGeneration === undefined ||
      product.metadata[productGenerationMetadataKey] === String(expectedGeneration))
  );
}

async function prepareProduct(
  stripe: StripeCatalogClient,
  listing: SeedListing,
) {
  const initialGeneration = 1;
  const metadata = productMetadata(listing.slug, initialGeneration);
  const existing = await findLocalSeedProduct(stripe, listing.slug);
  if (!existing) {
    const params = {
      active: true as const,
      description: listing.description,
      metadata,
      name: listing.title,
      shippable: true as const
    };
    const created = await stripe.products.create(params, {
      idempotencyKey: idempotencyKey(`product:${listing.slug}:create`, params)
    });
    assertTestResource(created, "Product");
    if (!productMatches(created, listing, initialGeneration)) {
      throw new Error(`Stripe returned an invalid Product for ${listing.slug}.`);
    }
    return { created: true, product: created };
  }

  assertTestResource(existing, "Product");
  const observedGeneration = productGeneration(existing);
  if (productMatches(existing, listing)) {
    return { created: false, product: existing };
  }

  const nextGeneration = observedGeneration + 1;
  const params = {
    active: true as const,
    description: listing.description,
    metadata: productMetadata(listing.slug, nextGeneration),
    name: listing.title
  };
  const updated = await stripe.products.update(existing.id, params, {
    idempotencyKey: idempotencyKey(`product:${listing.slug}:update`, {
      desired: params,
      observed: {
        active: existing.active,
        description: existing.description ?? null,
        generation: observedGeneration,
        name: existing.name
      }
    })
  });
  assertTestResource(updated, "Product");
  if (!productMatches(updated, listing, nextGeneration)) {
    throw new Error(`Stripe returned an invalid Product for ${listing.slug}.`);
  }
  return { created: false, product: updated };
}

async function findLocalSeedProduct(
  stripe: StripeCatalogClient,
  slug: string,
) {
  const matches: StripeCatalogProduct[] = [];
  const seenCursors = new Set<string>();
  let startingAfter: string | undefined;

  do {
    const page = await stripe.products.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    for (const product of page.data) {
      if (
        product.metadata.kapchi_catalog === catalogMarker &&
        product.metadata.kapchi_listing_slug === slug
      ) {
        matches.push(product);
        if (matches.length > 1) {
          throw new Error(
            `Stripe contains multiple local seed Products for ${slug}.`,
          );
        }
      }
    }

    if (!page.has_more) break;
    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Stripe Product pagination did not advance safely.");
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  } while (true);

  return matches[0];
}

function priceMatches(
  price: StripeCatalogPrice,
  input: {
    lookupKey: string;
    productId: string;
    slug: string;
    unitAmountCents: number;
    variantKey: string;
  },
) {
  const metadata = priceMetadata(input.slug, input.variantKey);
  return (
    price.active &&
    price.currency === "usd" &&
    price.lookup_key === input.lookupKey &&
    price.unit_amount === input.unitAmountCents &&
    productId(price.product) === input.productId &&
    Object.entries(metadata).every(([key, value]) => price.metadata[key] === value)
  );
}

async function preparePrice(
  stripe: StripeCatalogClient,
  listing: SeedListing,
  variant: SeedListing["priceVariants"][number],
  stripeProductId: string,
): Promise<PreparedPrice> {
  const lookupKey = buildStripePriceLookupKey(listing.slug, variant.variantKey);
  const matches = await stripe.prices.list({ limit: 2, lookup_keys: [lookupKey] });

  if (matches.data.length > 1) {
    throw new Error(`Stripe returned multiple Prices for lookup key ${lookupKey}.`);
  }

  const existing = matches.data[0];
  let resolvedPredecessorIds: string[] = [];
  if (existing) {
    assertOwnedLocalSeedPrice(existing, listing.slug, variant.variantKey);
    resolvedPredecessorIds = await resolvePricePredecessors(
      stripe,
      existing,
      listing.slug,
      variant.variantKey,
    );
    if (
      priceMatches(existing, {
        lookupKey,
        productId: stripeProductId,
        slug: listing.slug,
        unitAmountCents: variant.unitAmountCents,
        variantKey: variant.variantKey
      })
    ) {
      return {
        created: false,
        expectedCurrency: "usd",
        expectedUnitAmountCents: variant.unitAmountCents,
        id: existing.id,
        lookupKey,
        replacedPriceIds: resolvedPredecessorIds,
        variantKey: variant.variantKey
      };
    }
  }

  const replacedIds = existing
    ? [...new Set([existing.id, ...resolvedPredecessorIds])]
    : [];
  const params = {
    active: true as const,
    currency: "usd",
    lookup_key: lookupKey,
    metadata: priceMetadata(listing.slug, variant.variantKey, existing?.id),
    nickname: `${listing.title} - ${variant.variantKey}`,
    product: stripeProductId,
    transfer_lookup_key: Boolean(existing),
    unit_amount: variant.unitAmountCents
  };
  const generation = existing
    ? {
        active: existing.active,
        currency: existing.currency,
        id: existing.id,
        lookupKey: existing.lookup_key,
        productId: productId(existing.product),
        unitAmount: existing.unit_amount
      }
    : { id: null };
  const created = await stripe.prices.create(params, {
    idempotencyKey: idempotencyKey(`price:${lookupKey}:create`, {
      generation,
      params
    })
  });
  assertTestResource(created, "Price");
  if (
    !priceMatches(created, {
      lookupKey,
      productId: stripeProductId,
      slug: listing.slug,
      unitAmountCents: variant.unitAmountCents,
      variantKey: variant.variantKey
    }) ||
    created.metadata[predecessorPriceIdMetadataKey] !== existing?.id ||
    created.metadata[legacyPredecessorPriceIdsMetadataKey] !== undefined
  ) {
    throw new Error(`Stripe returned an invalid Price for lookup key ${lookupKey}.`);
  }

  return {
    created: true,
    expectedCurrency: "usd",
    expectedUnitAmountCents: variant.unitAmountCents,
    id: created.id,
    lookupKey,
    replacedPriceIds: replacedIds,
    variantKey: variant.variantKey
  };
}

async function prepareRemoteCatalog(
  stripe: StripeCatalogClient,
  catalog: readonly SeedListing[],
) {
  const prepared: PreparedListing[] = [];

  for (const listing of catalog) {
    const defaultVariant = listing.priceVariants[0];
    if (
      !defaultVariant ||
      defaultVariant.unitAmountCents !== listing.basePriceCents
    ) {
      throw new Error(
        `Local seed listing ${listing.slug} has an invalid default pricing identity.`,
      );
    }
    const { created, product } = await prepareProduct(stripe, listing);
    const prices: PreparedPrice[] = [];
    for (const variant of listing.priceVariants) {
      prices.push(await preparePrice(stripe, listing, variant, product.id));
    }
    prepared.push({
      created,
      defaultVariantKey: defaultVariant.variantKey,
      expectedBasePriceCents: listing.basePriceCents,
      expectedCurrency: "usd",
      prices,
      productId: product.id,
      slug: listing.slug
    });
  }

  return prepared;
}

async function updateCatalogMappings(
  client: Pick<StripeCatalogDatabaseClient, "query">,
  prepared: PreparedListing[],
) {
  for (const listing of prepared) {
    const defaultPrice = listing.prices.find(
      (price) => price.variantKey === listing.defaultVariantKey,
    );
    if (!defaultPrice) {
      throw new Error(`Prepared listing ${listing.slug} has no default Price.`);
    }
    const listingResult = await client.query<{ id: string }>(
      `
        update listings l
        set stripe_product_id = $2, default_stripe_price_id = $3
        where l.slug = $1
          and l.base_price_cents = $4
          and l.currency = $5
          and exists (
            select 1
            from listing_price_variants default_variant
            where default_variant.listing_id = l.id
              and default_variant.variant_key = $6
              and default_variant.active = true
              and default_variant.unit_amount_cents = $7
              and default_variant.currency = $8
          )
        returning l.id
      `,
      [
        listing.slug,
        listing.productId,
        defaultPrice.id,
        listing.expectedBasePriceCents,
        listing.expectedCurrency,
        listing.defaultVariantKey,
        defaultPrice.expectedUnitAmountCents,
        defaultPrice.expectedCurrency
      ],
    );
    if (listingResult.rows.length !== 1) {
      throw new Error(
        `Local seed listing ${listing.slug} changed after Stripe preparation.`,
      );
    }

    for (const price of listing.prices) {
      await client.query(
        `
          update listing_price_variants collision
          set stripe_price_id =
            'price_local_seed_retired_' || replace(collision.id::text, '-', '')
          from listings l
          where collision.listing_id = l.id
            and l.slug = $1
            and collision.stripe_price_id = $3
            and (collision.variant_key <> $2 or collision.active = false)
        `,
        [listing.slug, price.variantKey, price.id],
      );
      const priceResult = await client.query<{ id: string }>(
        `
          update listing_price_variants lpv
          set stripe_product_id = $3, stripe_price_id = $4
          from listings l
          where lpv.listing_id = l.id
            and l.slug = $1
            and lpv.variant_key = $2
            and lpv.active = true
            and lpv.unit_amount_cents = $5
            and lpv.currency = $6
          returning lpv.id
        `,
        [
          listing.slug,
          price.variantKey,
          listing.productId,
          price.id,
          price.expectedUnitAmountCents,
          price.expectedCurrency
        ],
      );
      if (priceResult.rows.length !== 1) {
        throw new Error(
          `Active local seed price variant ${listing.slug}/${price.variantKey} changed after Stripe preparation.`,
        );
      }
    }
  }
}

export async function recoverLocalPlaceholderOrders(
  client: Pick<StripeCatalogDatabaseClient, "query">,
) {
  const seedSlugs = seedListings.map((listing) => listing.slug);
  const placeholderBindings = seedListings.flatMap((listing) =>
    listing.priceVariants.map((variant) => ({
      priceId: variant.stripePriceId,
      productId: listing.stripeProductId,
      slug: listing.slug
    })),
  );
  const result = await client.query<RecoveredOrderRow>(
    `
      with eligible_orders as (
        select o.id, o.cart_id
        from orders o
        join carts c on c.id = o.cart_id
        where o.status = 'pending_payment'
          and o.payment_status = 'failed'
          and o.stripe_checkout_session_id is null
          and c.status = 'checkout_started'
          and (c.expires_at is null or c.expires_at > now())
          and exists (
            select 1
            from order_items oi
            join listings l on l.id = oi.listing_id
            where oi.order_id = o.id
              and l.slug = any($1::text[])
          )
          and not exists (
            select 1
            from order_items oi
            left join listings l on l.id = oi.listing_id
            where oi.order_id = o.id
              and (
                l.slug is null
                or not (l.slug = any($1::text[]))
                or oi.stripe_price_id is null
                or oi.stripe_product_id is null
              )
          )
          and (
            not exists (
              select 1
              from order_items oi
              join listings l on l.id = oi.listing_id
              where oi.order_id = o.id
                and not exists (
                  select 1
                  from unnest(
                    $2::text[], $3::text[], $4::text[]
                  ) as placeholder(slug, product_id, price_id)
                  where placeholder.slug = l.slug
                    and placeholder.product_id = oi.stripe_product_id
                    and placeholder.price_id = oi.stripe_price_id
                )
            )
            or exists (
              select 1
              from order_events catalog_failure
              where catalog_failure.order_id = o.id
                and catalog_failure.event_type = 'checkout.catalog_unavailable'
            )
          )
          and not exists (
            select 1
            from orders other
            where other.cart_id = c.id
              and other.id <> o.id
              and (
                other.payment_status = 'paid'
                or (
                  other.status = 'pending_payment'
                  and other.payment_status in ('unpaid', 'checkout_started')
                )
              )
          )
        for update of o, c
      ), recovered as (
        update orders o
        set
          status = 'cancelled',
          payment_status = 'failed',
          cancelled_at = now()
        from eligible_orders eligible
        where o.id = eligible.id
        returning o.id, o.cart_id
      ), recorded_events as (
        insert into order_events (
          order_id, actor_type, actor_id, event_type,
          from_value, to_value, metadata
        )
        select
          recovered.id,
          'system',
          'stripe-test-catalog-sync',
          'checkout.catalog_mapping_recovered',
          'pending_payment',
          'cancelled',
          '{"reason":"local_seed_catalog_mapping","source":"stripe_test_catalog_sync"}'::jsonb
        from recovered
        returning order_id
      ), cart_dispositions as (
        update carts c
        set status = case
          when exists (
            select 1
            from carts competing_cart
            where competing_cart.id <> c.id
              and competing_cart.status = 'active'
              and (
                (c.user_id is not null and competing_cart.user_id = c.user_id)
                or (
                  c.authenticated_user_id is not null
                  and competing_cart.authenticated_user_id = c.authenticated_user_id
                )
                or (
                  c.guest_token_hash is not null
                  and competing_cart.guest_token_hash = c.guest_token_hash
                )
              )
          ) then 'abandoned'::cart_status
          else 'active'::cart_status
        end
        from recovered
        where c.id = recovered.cart_id
        returning c.id, c.status
      ), released_reservations as (
        update fabric_reservations reservation
        set status = 'released', expires_at = now()
        from recovered
        join cart_dispositions disposition
          on disposition.id = recovered.cart_id
        where reservation.order_id = recovered.id
          and reservation.status = 'active'
          and disposition.status = 'abandoned'
        returning reservation.fabric_id, reservation.quantity
      ), reservation_totals as (
        select fabric_id, sum(quantity)::integer as quantity
        from released_reservations
        group by fabric_id
      ), updated_fabrics as (
        update fabrics fabric
        set quantity_reserved = greatest(
          0,
          fabric.quantity_reserved - reservation_totals.quantity
        )
        from reservation_totals
        where fabric.id = reservation_totals.fabric_id
        returning fabric.id
      )
      select
        recovered.id as order_id,
        recovered.cart_id,
        (cart_dispositions.status = 'active') as cart_reactivated
      from recovered
      join cart_dispositions on cart_dispositions.id = recovered.cart_id
      order by recovered.id
    `,
    [
      seedSlugs,
      placeholderBindings.map((binding) => binding.slug),
      placeholderBindings.map((binding) => binding.productId),
      placeholderBindings.map((binding) => binding.priceId)
    ],
  );
  return result.rows;
}

function explicitReplacedPriceIds(prepared: PreparedListing[]) {
  return [...new Set(
    prepared.flatMap((listing) =>
      listing.prices.flatMap((price) =>
        price.replacedPriceIds.filter((id) => id !== price.id),
      ),
    ),
  )];
}

export async function findProtectedReplacedPriceIds(
  client: Pick<StripeCatalogDatabaseClient, "query">,
  candidatePriceIds: readonly string[],
) {
  if (candidatePriceIds.length === 0) return new Set<string>();

  const result = await client.query<ProtectedPriceRow>(
    `
      select distinct oi.stripe_price_id
      from order_items oi
      join orders o on o.id = oi.order_id
      where oi.stripe_price_id = any($1::text[])
        and o.status = 'pending_payment'
        and o.stripe_checkout_session_id is null
        and not exists (
          select 1
          from order_events catalog_failure
          where catalog_failure.order_id = o.id
            and catalog_failure.event_type = 'checkout.catalog_unavailable'
        )
      order by oi.stripe_price_id
    `,
    [[...new Set(candidatePriceIds)]],
  );
  return new Set(result.rows.map((row) => row.stripe_price_id));
}

async function persistPreparedCatalog(
  client: StripeCatalogDatabaseClient,
  prepared: PreparedListing[],
) {
  try {
    await client.query("begin");
    await updateCatalogMappings(client, prepared);
    const recovered = await recoverLocalPlaceholderOrders(client);
    const protectedPriceIds = await findProtectedReplacedPriceIds(
      client,
      explicitReplacedPriceIds(prepared),
    );
    await client.query("commit");
    return { protectedPriceIds, recovered };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Releasing the client with the original error removes a damaged session.
    }
    throw error;
  }
}

async function cleanupReplacedPrices(
  stripe: StripeCatalogClient,
  prepared: PreparedListing[],
  protectedPriceIds: ReadonlySet<string>,
) {
  let failures = 0;
  const processedPriceIds = new Set<string>();
  for (const listing of prepared) {
    for (const price of listing.prices) {
      for (const replacedPriceId of price.replacedPriceIds) {
        if (
          replacedPriceId === price.id ||
          protectedPriceIds.has(replacedPriceId) ||
          processedPriceIds.has(replacedPriceId)
        ) {
          continue;
        }
        processedPriceIds.add(replacedPriceId);

        try {
          const candidate = await stripe.prices.retrieve(replacedPriceId);
          assertTestResource(candidate, "Price");
          if (
            candidate.metadata.kapchi_catalog !== catalogMarker ||
            candidate.metadata.kapchi_listing_slug !== listing.slug ||
            candidate.metadata.kapchi_variant_key !== price.variantKey
          ) {
            throw new Error(
              "Replacement metadata does not identify a Kapchi local Price.",
            );
          }
          if (!candidate.active) continue;

          await stripe.prices.update(
            candidate.id,
            { active: false },
            {
              idempotencyKey: idempotencyKey(
                `price:${candidate.id}:deactivate`,
                { replacementPriceId: price.id },
              )
            },
          );
        } catch {
          failures += 1;
        }
      }
    }
  }
  return failures;
}

export async function syncStripeTestCatalog(input: StripeCatalogSyncInput) {
  assertStripeCatalogSyncSafe(input);
  const catalog = input.catalog ?? seedListings;
  assertLocalSeedCatalog(catalog);
  const client = await input.database.connect();
  let lockAcquired = false;
  let operationError: unknown;

  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1) as acquired",
      [stripeCatalogSyncAdvisoryLockId],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new StripeCatalogSyncAlreadyRunningError();
    }
    lockAcquired = true;

    const account = await input.stripe.accounts.retrieve();
    if (!account.id || !account.id.startsWith("acct_")) {
      throw new Error("Stripe test account could not be verified.");
    }

    const prepared = await prepareRemoteCatalog(input.stripe, catalog);
    const { protectedPriceIds, recovered } = await persistPreparedCatalog(
      client,
      prepared,
    );
    const cleanupFailures = await cleanupReplacedPrices(
      input.stripe,
      prepared,
      protectedPriceIds,
    );

    return {
      accountId: account.id,
      bindings: prepared.map((listing) => ({
        prices: listing.prices.map((price) => ({
          id: price.id,
          lookupKey: price.lookupKey,
          variantKey: price.variantKey
        })),
        productId: listing.productId,
        slug: listing.slug
      })),
      cartsReactivated: recovered.filter((row) => row.cart_reactivated).length,
      cleanupFailures,
      ordersRecovered: recovered.length,
      pricesProtected: protectedPriceIds.size,
      pricesCreated: prepared.flatMap((listing) => listing.prices).filter(
        (price) => price.created,
      ).length,
      pricesReused: prepared.flatMap((listing) => listing.prices).filter(
        (price) => !price.created,
      ).length,
      productsCreated: prepared.filter((listing) => listing.created).length,
      productsReused: prepared.filter((listing) => !listing.created).length
    } satisfies StripeCatalogSyncResult;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError: Error | undefined;
    if (lockAcquired) {
      try {
        const unlock = await client.query<{ released: boolean }>(
          "select pg_advisory_unlock($1) as released",
          [stripeCatalogSyncAdvisoryLockId],
        );
        if (unlock.rows[0]?.released !== true) {
          throw new Error("Stripe catalog sync advisory lock was not released.");
        }
      } catch {
        releaseError = new Error("Stripe catalog sync could not release its advisory lock.");
      }
    }
    client.release(releaseError);
    if (releaseError && operationError === undefined) throw releaseError;
  }
}
