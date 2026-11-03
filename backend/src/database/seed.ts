import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";

loadBackendEnvironment();

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type SeedListing = {
  basePriceCents: number;
  description: string;
  imageAlt: string;
  imageUrl: string;
  listingType: "graduation_stole" | "accessory" | "other";
  priceVariants: Array<{
    customizationKind: string;
    stripePriceId: string;
    unitAmountCents: number;
    variantKey: string;
  }>;
  requiresFabric: boolean;
  slug: string;
  stripeProductId: string;
  subtitle: string;
  title: string;
};

type SeedFabric = {
  colorHex: string;
  colorName: string;
  imageAlt: string;
  imageUrl: string;
  material: string;
  name: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantitySold: number;
  sku: string;
  status: "active" | "archived";
};

const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const seededAtIso = "2026-01-01T00:00:00.000Z";
const seededAt = new Date(seededAtIso);

const localProductionEstimateDays: Record<
  string,
  { rush: [number, number]; standard: [number, number] }
> = {
  blank: { rush: [1, 2], standard: [3, 5] },
  text_short: { rush: [3, 4], standard: [5, 7] },
  text_long: { rush: [4, 6], standard: [7, 10] },
  text_image: { rush: [7, 9], standard: [10, 14] },
  text_image_trim: { rush: [10, 12], standard: [14, 18] }
};

export const localSeedFixtures = {
  asset: {
    id: "00000000-0000-4000-8000-000000000061",
    objectKey: "local-seed/uploads/class-of-2026.png",
    url: "https://example.test/kapchi-local-seed/uploads/class-of-2026.png"
  },
  cart: {
    id: "00000000-0000-4000-8000-000000000053",
    itemId: "00000000-0000-4000-8000-000000000253",
    userId: "user_local_seed_demo"
  },
  contact: {
    email: "local-demo@example.test",
    name: "Local Seed Customer",
    phone: "+1555010053"
  },
  order: {
    id: "00000000-0000-4000-8000-000000000153",
    itemId: "00000000-0000-4000-8000-000000000353",
    publicOrderNumber: "LOCAL-SEED-1001"
  },
  seededAtIso
} as const;

export const seedListings: SeedListing[] = [
  {
    basePriceCents: 4500,
    description:
      "Local seed graduation stole with editable text, image, trim, and fabric options.",
    imageAlt: "Local seed navy graduation stole preview",
    imageUrl: "/images/hero/personalized-woven-stole.webp",
    listingType: "graduation_stole",
    priceVariants: [
      {
        customizationKind: "blank",
        stripePriceId: "price_local_seed_stole_blank",
        unitAmountCents: 4500,
        variantKey: "blank"
      },
      {
        customizationKind: "text_short",
        stripePriceId: "price_local_seed_stole_text_short",
        unitAmountCents: 5000,
        variantKey: "text-short"
      },
      {
        customizationKind: "text_long",
        stripePriceId: "price_local_seed_stole_text_long",
        unitAmountCents: 5500,
        variantKey: "text-long"
      },
      {
        customizationKind: "text_image",
        stripePriceId: "price_local_seed_stole_text_image",
        unitAmountCents: 6000,
        variantKey: "text-long-image"
      },
      {
        customizationKind: "text_image_trim",
        stripePriceId: "price_local_seed_stole_personalized",
        unitAmountCents: 6500,
        variantKey: "text-image-trim"
      }
    ],
    requiresFabric: true,
    slug: "local-seed-classic-graduation-stole",
    stripeProductId: "prod_local_seed_classic_stole",
    subtitle: "Seed data only",
    title: "Classic Graduation Stole"
  },
  {
    basePriceCents: 1800,
    description:
      "Local seed honor cord accessory for cart and checkout workflow testing.",
    imageAlt: "Local seed gold honor cord preview",
    imageUrl: "https://example.test/kapchi-local-seed/gold-cord.png",
    listingType: "accessory",
    priceVariants: [
      {
        customizationKind: "blank",
        stripePriceId: "price_local_seed_honor_cord",
        unitAmountCents: 1800,
        variantKey: "blank"
      }
    ],
    requiresFabric: false,
    slug: "local-seed-gold-honor-cord",
    stripeProductId: "prod_local_seed_honor_cord",
    subtitle: "Seed data only",
    title: "Gold Honor Cord"
  }
];

export const seedFabrics: SeedFabric[] = [
  {
    colorHex: "#12335B",
    colorName: "Navy",
    imageAlt: "Woven blue fabric detail on a graduation stole",
    imageUrl: "/images/hero/woven-stole-detail.webp",
    material: "Satin",
    name: "Local Seed Navy Satin",
    quantityOnHand: 40,
    quantityReserved: 1,
    quantitySold: 3,
    sku: "LOCAL-SEED-NAVY-SATIN",
    status: "active"
  },
  {
    colorHex: "#D4AF37",
    colorName: "Gold",
    imageAlt: "Gold-trimmed woven fabric samples beside a graduation stole",
    imageUrl: "/images/hero/personalized-woven-stole.webp",
    material: "Satin",
    name: "Local Seed Gold Satin",
    quantityOnHand: 30,
    quantityReserved: 0,
    quantitySold: 2,
    sku: "LOCAL-SEED-GOLD-SATIN",
    status: "active"
  }
];

export function assertSafeLocalSeedTarget(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV ?? "development",
) {
  if (nodeEnv === "production") {
    throw new Error("Refusing to seed local data when NODE_ENV=production.");
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed local data.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }

  if (!localHostnames.has(parsedUrl.hostname)) {
    throw new Error(
      `Refusing to seed non-local database host "${parsedUrl.hostname}". Use a localhost PostgreSQL database for db:seed:local.`,
    );
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));

  if (!/(?:^|_)(dev|test|local)(?:_|$)/i.test(databaseName)) {
    throw new Error(
      `Refusing to seed database "${databaseName}". Local seed databases must include dev, test, or local in the database name.`,
    );
  }
}

async function queryOne<T extends QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[],
) {
  const result = await db.query<T>(text, values);

  if (!result.rows[0]) {
    throw new Error("Expected seed query to return a row.");
  }

  return result.rows[0];
}

async function seedFonts(db: Queryable) {
  await db.query(
    `
      insert into font_options (name, css_family, preview_text, active)
      values
        ('Local Serif', 'Georgia, serif', 'Class of 2026', true),
        ('Local Sans', 'Inter, Arial, sans-serif', 'Kapchi Local', true),
        ('Local Script', '"Brush Script MT", cursive', 'Congrats!', true)
      on conflict (name) do update set
        css_family = excluded.css_family,
        preview_text = excluded.preview_text,
        active = excluded.active
    `,
  );
}

async function seedTrims(db: Queryable) {
  await db.query(
    `
      insert into trim_options (name, color_name, color_hex, price_delta_cents, active)
      values
        ('Local Gold Trim', 'Gold', '#D4AF37', 600, true),
        ('Local White Trim', 'White', '#FFFFFF', 400, true),
        ('Local Crimson Trim', 'Crimson', '#B11226', 500, true)
      on conflict (name) do update set
        color_name = excluded.color_name,
        color_hex = excluded.color_hex,
        price_delta_cents = excluded.price_delta_cents,
        active = excluded.active
    `,
  );
}

async function seedFabricInventory(db: Queryable) {
  await db.query(
    `
      insert into fabrics (
        sku,
        name,
        color_name,
        color_hex,
        material,
        status,
        quantity_on_hand,
        quantity_reserved,
        quantity_sold
      ) values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9),
        ($10, $11, $12, $13, $14, $15, $16, $17, $18)
      on conflict (sku) do update set
        name = excluded.name,
        color_name = excluded.color_name,
        color_hex = excluded.color_hex,
        material = excluded.material,
        status = excluded.status,
        quantity_on_hand = excluded.quantity_on_hand,
        quantity_reserved = excluded.quantity_reserved,
        quantity_sold = excluded.quantity_sold
    `,
    seedFabrics.flatMap((fabric) => [
      fabric.sku,
      fabric.name,
      fabric.colorName,
      fabric.colorHex,
      fabric.material,
      fabric.status,
      fabric.quantityOnHand,
      fabric.quantityReserved,
      fabric.quantitySold
    ]),
  );

  for (const fabric of seedFabrics) {
    await db.query(
      `
        insert into assets (
          provider,
          storage_key,
          url,
          content_type,
          byte_size,
          visibility,
          context,
          status,
          fabric_id,
          metadata
        )
        select
          'local_public',
          'local-seed/fabrics/' || lower(replace(f.sku, '_', '-')) || '.webp',
          $2,
          'image/webp',
          1,
          'public_catalog',
          'fabric_image',
          'uploaded',
          f.id,
          $3::jsonb
        from fabrics f
        where f.sku = $1
        on conflict (provider, storage_key) where storage_key is not null
        do update set
          url = excluded.url,
          content_type = excluded.content_type,
          byte_size = excluded.byte_size,
          visibility = excluded.visibility,
          context = excluded.context,
          status = excluded.status,
          fabric_id = excluded.fabric_id,
          metadata = excluded.metadata
      `,
      [
        fabric.sku,
        fabric.imageUrl,
        JSON.stringify({
          alt: fabric.imageAlt,
          sortOrder: 0,
          source: "db:seed:local"
        })
      ],
    );
  }
}

export async function seedListing(db: Queryable, listing: SeedListing) {
  const defaultVariant = listing.priceVariants[0];
  if (!defaultVariant || defaultVariant.unitAmountCents !== listing.basePriceCents) {
    throw new Error(
      `Local seed listing ${listing.slug} must use its first price variant as the base price.`,
    );
  }

  const catalogImageContentType = listing.imageUrl.endsWith(".webp")
    ? "image/webp"
    : "image/png";
  const catalogImageExtension = catalogImageContentType.split("/")[1];
  const listingRow = await queryOne<{ id: string }>(
    db,
    `
      insert into listings (
        slug,
        title,
        subtitle,
        description,
        listing_type,
        status,
        base_price_cents,
        currency,
        requires_fabric,
        stripe_product_id,
        default_stripe_price_id
      ) values ($1, $2, $3, $4, $5, 'active', $6, 'usd', $7, $8, $9)
      on conflict (slug) do update set
        title = excluded.title,
        subtitle = excluded.subtitle,
        description = excluded.description,
        listing_type = excluded.listing_type,
        status = excluded.status,
        base_price_cents = excluded.base_price_cents,
        currency = excluded.currency,
        requires_fabric = excluded.requires_fabric,
        stripe_product_id = case
          when listings.base_price_cents = excluded.base_price_cents
            and listings.currency = excluded.currency
            and listings.stripe_product_id not like 'prod_local_seed_%'
            and listings.default_stripe_price_id not like 'price_local_seed_%'
            and exists (
              select 1
              from listing_price_variants default_variant
              where default_variant.listing_id = listings.id
                and default_variant.active = true
                and default_variant.stripe_price_id = listings.default_stripe_price_id
                and default_variant.unit_amount_cents = excluded.base_price_cents
                and default_variant.currency = excluded.currency
            )
          then listings.stripe_product_id
          else excluded.stripe_product_id
        end,
        default_stripe_price_id = case
          when listings.base_price_cents = excluded.base_price_cents
            and listings.currency = excluded.currency
            and listings.stripe_product_id not like 'prod_local_seed_%'
            and listings.default_stripe_price_id not like 'price_local_seed_%'
            and exists (
              select 1
              from listing_price_variants default_variant
              where default_variant.listing_id = listings.id
                and default_variant.active = true
                and default_variant.stripe_price_id = listings.default_stripe_price_id
                and default_variant.unit_amount_cents = excluded.base_price_cents
                and default_variant.currency = excluded.currency
            )
          then listings.default_stripe_price_id
          else excluded.default_stripe_price_id
        end,
        archived_at = null
      returning id
    `,
    [
      listing.slug,
      listing.title,
      listing.subtitle,
      listing.description,
      listing.listingType,
      listing.basePriceCents,
      listing.requiresFabric,
      listing.stripeProductId,
      listing.priceVariants[0]?.stripePriceId
    ],
  );

  await db.query(
    "delete from listing_images where listing_id = $1 and image_url like 'https://example.test/kapchi-local-seed/%'",
    [listingRow.id],
  );

  await db.query(
    `
      insert into listing_images (listing_id, image_url, alt_text, sort_order, is_primary)
      values ($1, $2, $3, 0, true)
      on conflict (listing_id) where is_primary
      do update set
        image_url = excluded.image_url,
        alt_text = excluded.alt_text,
        sort_order = excluded.sort_order
    `,
    [listingRow.id, listing.imageUrl, listing.imageAlt],
  );

  await db.query(
    `
      insert into assets (
        provider,
        storage_key,
        url,
        content_type,
        byte_size,
        visibility,
        context,
        status,
        listing_id,
        metadata
      ) values (
        'local_public',
        $2,
        $3,
        $5,
        1,
        'public_catalog',
        'catalog_listing_image',
        'uploaded',
        $1,
        $4::jsonb
      )
      on conflict (provider, storage_key) where storage_key is not null
      do update set
        url = excluded.url,
        content_type = excluded.content_type,
        byte_size = excluded.byte_size,
        visibility = excluded.visibility,
        context = excluded.context,
        status = excluded.status,
        listing_id = excluded.listing_id,
        metadata = excluded.metadata
    `,
    [
      listingRow.id,
      `local-seed/listings/${listing.slug}.${catalogImageExtension}`,
      listing.imageUrl,
      JSON.stringify({
        alt: listing.imageAlt,
        isPrimary: true,
        sortOrder: 0,
        source: "db:seed:local"
      }),
      catalogImageContentType
    ],
  );

  if (listing.requiresFabric) {
    await db.query(
      `
        insert into listing_fabrics (listing_id, fabric_id, active, is_default, sort_order)
        select $1, id, true, sku = 'LOCAL-SEED-NAVY-SATIN', case sku
          when 'LOCAL-SEED-NAVY-SATIN' then 0
          else 1
        end
        from fabrics
        where sku in ('LOCAL-SEED-NAVY-SATIN', 'LOCAL-SEED-GOLD-SATIN')
        on conflict (listing_id, fabric_id) do update set
          active = excluded.active,
          is_default = excluded.is_default,
          sort_order = excluded.sort_order
      `,
      [listingRow.id],
    );
  }

  await db.query(
    "update listing_customization_sets set enabled = false where listing_id = $1",
    [listingRow.id],
  );
  for (const variant of listing.priceVariants) {
    const customizationRow = await queryOne<{ id: string }>(
      db,
      `
        insert into listing_customization_sets (
          listing_id,
          customization_set_id,
          enabled,
          price_delta_cents,
          max_chars,
          min_chars,
          image_max_bytes,
          sort_order
        )
        select
          $1,
          id,
          true,
          $2,
          default_max_chars,
          0,
          case when requires_image then 5242880 else null end,
          $3
        from customization_sets
        where kind = $4
        on conflict (listing_id, customization_set_id) do update set
          enabled = excluded.enabled,
          price_delta_cents = excluded.price_delta_cents,
          max_chars = excluded.max_chars,
          min_chars = excluded.min_chars,
          image_max_bytes = excluded.image_max_bytes,
          sort_order = excluded.sort_order
        returning id
      `,
      [
        listingRow.id,
        variant.unitAmountCents - listing.basePriceCents,
        listing.priceVariants.indexOf(variant),
        variant.customizationKind
      ],
    );

    const productionDays = localProductionEstimateDays[variant.customizationKind];
    if (listing.listingType === "graduation_stole" && productionDays) {
      for (const [sortOrder, priorityCode] of ["standard", "rush"].entries()) {
        const [minimumBusinessDays, maximumBusinessDays] =
          productionDays[priorityCode as "standard" | "rush"];
        await db.query(
          `
            insert into listing_production_estimate_rules (
              listing_id,
              listing_customization_set_id,
              priority_code,
              label,
              minimum_business_days,
              maximum_business_days,
              revision,
              is_default,
              active,
              sort_order
            ) values ($1, $2, $3, $4, $5, $6, 1, $7, true, $8)
            on conflict (listing_customization_set_id, priority_code, revision)
            do nothing
          `,
          [
            listingRow.id,
            customizationRow.id,
            priorityCode,
            priorityCode === "standard" ? "Standard" : "Rush",
            minimumBusinessDays,
            maximumBusinessDays,
            priorityCode === "standard",
            sortOrder
          ],
        );
      }
    }

    await db.query(
      `
        insert into listing_customization_fonts (
          listing_customization_set_id,
          font_option_id
        )
        select $1, id
        from font_options
        where active and name in ('Local Serif', 'Local Sans', 'Local Script')
        on conflict do nothing
      `,
      [customizationRow.id],
    );

    await db.query(
      `
        insert into listing_customization_trims (
          listing_customization_set_id,
          trim_option_id
        )
        select $1, id
        from trim_options
        where active and name in ('Local Gold Trim', 'Local White Trim', 'Local Crimson Trim')
        on conflict do nothing
      `,
      [customizationRow.id],
    );

    await db.query(
      `
        update listing_price_variants collision
        set stripe_price_id =
          'price_local_seed_retired_' || replace(collision.id::text, '-', '')
        where collision.listing_id = $1
          and collision.stripe_price_id = $2
          and not (collision.variant_key = $3 and collision.active = true)
      `,
      [listingRow.id, variant.stripePriceId, variant.variantKey],
    );

    await db.query(
      `
        update listing_price_variants
        set
          listing_customization_set_id = $2,
          trim_option_id = null,
          unit_amount_cents = $4,
          currency = 'usd',
          stripe_product_id = case
            when unit_amount_cents = $4
              and currency = 'usd'
              and stripe_product_id not like 'prod_local_seed_%'
              and stripe_price_id not like 'price_local_seed_%'
            then stripe_product_id
            else $5
          end,
          stripe_price_id = case
            when unit_amount_cents = $4
              and currency = 'usd'
              and stripe_product_id not like 'prod_local_seed_%'
              and stripe_price_id not like 'price_local_seed_%'
            then stripe_price_id
            else $6
          end,
          active = true,
          replaced_at = null
        where listing_id = $1 and variant_key = $3 and active = true
      `,
      [
        listingRow.id,
        customizationRow.id,
        variant.variantKey,
        variant.unitAmountCents,
        listing.stripeProductId,
        variant.stripePriceId
      ],
    );

    await db.query(
      `
        insert into listing_price_variants (
          listing_id,
          listing_customization_set_id,
          trim_option_id,
          variant_key,
          unit_amount_cents,
          currency,
          stripe_product_id,
          stripe_price_id,
          active
        )
        select $1, $2, null, $3, $4, 'usd', $5, $6, true
        where not exists (
          select 1
          from listing_price_variants
          where listing_id = $1 and variant_key = $3 and active = true
        )
        on conflict (stripe_price_id) do update set
          listing_id = excluded.listing_id,
          listing_customization_set_id = excluded.listing_customization_set_id,
          trim_option_id = excluded.trim_option_id,
          variant_key = excluded.variant_key,
          unit_amount_cents = excluded.unit_amount_cents,
          currency = excluded.currency,
          stripe_product_id = excluded.stripe_product_id,
          active = excluded.active,
          replaced_at = null
      `,
      [
        listingRow.id,
        customizationRow.id,
        variant.variantKey,
        variant.unitAmountCents,
        listing.stripeProductId,
        variant.stripePriceId
      ],
    );
  }

  await db.query(
    `update listing_price_variants
     set active = false, replaced_at = coalesce(replaced_at, now())
     where listing_id = $1
       and active = true
       and not (variant_key = any($2::text[]))`,
    [listingRow.id, listing.priceVariants.map((variant) => variant.variantKey)],
  );
}

async function seedCartAndOrder(db: Queryable) {
  const cartId = localSeedFixtures.cart.id;
  const orderId = localSeedFixtures.order.id;
  const assetId = localSeedFixtures.asset.id;
  const cartItemId = localSeedFixtures.cart.itemId;
  const orderItemId = localSeedFixtures.order.itemId;

  const listingRow = await queryOne<{
    customization_set_id: string;
    fabric_id: string;
    listing_id: string;
    price_variant_id: string;
    stripe_price_id: string;
    stripe_product_id: string;
    unit_amount_cents: number;
  }>(
    db,
    `
      select
        l.id as listing_id,
        lcs.id as customization_set_id,
        lpv.id as price_variant_id,
        lpv.stripe_price_id,
        lpv.stripe_product_id,
        lpv.unit_amount_cents,
        f.id as fabric_id
      from listings l
      join listing_customization_sets lcs on lcs.listing_id = l.id
      join customization_sets cs on cs.id = lcs.customization_set_id
      join listing_price_variants lpv
        on lpv.listing_id = l.id
        and lpv.listing_customization_set_id = lcs.id
      join listing_fabrics lf on lf.listing_id = l.id and lf.is_default
      join fabrics f on f.id = lf.fabric_id
      where l.slug = 'local-seed-classic-graduation-stole'
        and cs.kind = 'text_image_trim'
      limit 1
    `,
    [],
  );

  await db.query(
    `
      insert into carts (
        id,
        user_id,
        guest_token_hash,
        status,
        currency,
        subtotal_cents,
        converted_order_id,
        expires_at
      ) values ($1, $4, null, 'converted', 'usd', $2, null, $3)
      on conflict (id) do update set
        user_id = excluded.user_id,
        guest_token_hash = excluded.guest_token_hash,
        status = excluded.status,
        currency = excluded.currency,
        subtotal_cents = excluded.subtotal_cents,
        expires_at = excluded.expires_at
    `,
    [cartId, listingRow.unit_amount_cents, seededAt, localSeedFixtures.cart.userId],
  );

  await db.query(
    `
      insert into assets (
        id,
        provider,
        storage_key,
        url,
        content_type,
        byte_size,
        checksum,
        visibility,
        context,
        status,
        cart_id,
        listing_id,
        metadata
      ) values (
        $1,
        'vercel_blob',
        $4,
        $5,
        'image/png',
        2048,
        'local-seed-checksum',
        'private',
        'customization_image',
        'attached',
        $2,
        $3,
        $6
      )
      on conflict (id) do update set
        provider = excluded.provider,
        storage_key = excluded.storage_key,
        url = excluded.url,
        content_type = excluded.content_type,
        byte_size = excluded.byte_size,
        checksum = excluded.checksum,
        visibility = excluded.visibility,
        context = excluded.context,
        status = excluded.status,
        cart_id = excluded.cart_id,
        listing_id = excluded.listing_id,
        metadata = excluded.metadata
    `,
    [
      assetId,
      cartId,
      listingRow.listing_id,
      localSeedFixtures.asset.objectKey,
      localSeedFixtures.asset.url,
      JSON.stringify({
        originalFilename: "class-of-2026.png",
        source: "db:seed:local"
      })
    ],
  );

  await db.query("delete from cart_items where id = $1", [cartItemId]);
  await db.query(
    `
      insert into cart_items (
        id,
        cart_id,
        listing_id,
        listing_customization_set_id,
        listing_price_variant_id,
        fabric_id,
        quantity,
        unit_amount_cents,
        currency,
        customization_payload,
        customization_asset_id,
        validation_status
      ) values ($1, $2, $3, $4, $5, $6, 1, $7, 'usd', $8, $9, 'valid')
    `,
    [
      cartItemId,
      cartId,
      listingRow.listing_id,
      listingRow.customization_set_id,
      listingRow.price_variant_id,
      listingRow.fabric_id,
      listingRow.unit_amount_cents,
      JSON.stringify({
        fontOptionId: null,
        imageAssetId: assetId,
        line1: "Class of 2026",
        line2: "Kapchi Demo",
        trimOptionId: null
      }),
      assetId
    ],
  );

  await db.query(
    `
      insert into orders (
        id,
        public_order_number,
        user_id,
        cart_id,
        status,
        payment_status,
        fulfillment_status,
        customer_email,
        customer_phone,
        preferred_contact_method,
        shipping_name,
        shipping_address,
        shipping_address_status,
        subtotal_cents,
        shipping_cents,
        tax_cents,
        discount_cents,
        total_cents,
        currency,
        stripe_checkout_session_id,
        stripe_payment_intent_id,
        stripe_customer_id,
        checkout_expires_at,
        paid_at
      ) values (
        $1,
        $7,
        $8,
        $2,
        'paid',
        'paid',
        'queued',
        $9,
        $10,
        'email',
        $11,
        $3,
        'valid',
        $4,
        895,
        0,
        0,
        $5,
        'usd',
        'cs_test_local_seed_1001',
        'pi_test_local_seed_1001',
        'cus_test_local_seed_1001',
        $6,
        $6
      )
      on conflict (id) do update set
        public_order_number = excluded.public_order_number,
        user_id = excluded.user_id,
        cart_id = excluded.cart_id,
        status = excluded.status,
        payment_status = excluded.payment_status,
        fulfillment_status = excluded.fulfillment_status,
        customer_email = excluded.customer_email,
        customer_phone = excluded.customer_phone,
        preferred_contact_method = excluded.preferred_contact_method,
        shipping_name = excluded.shipping_name,
        shipping_address = excluded.shipping_address,
        shipping_address_status = excluded.shipping_address_status,
        shipping_address_issue_code = null,
        subtotal_cents = excluded.subtotal_cents,
        shipping_cents = excluded.shipping_cents,
        tax_cents = excluded.tax_cents,
        discount_cents = excluded.discount_cents,
        total_cents = excluded.total_cents,
        currency = excluded.currency,
        stripe_checkout_session_id = excluded.stripe_checkout_session_id,
        stripe_payment_intent_id = excluded.stripe_payment_intent_id,
        stripe_customer_id = excluded.stripe_customer_id,
        checkout_expires_at = excluded.checkout_expires_at,
        paid_at = excluded.paid_at,
        cancelled_at = null
    `,
    [
      orderId,
      cartId,
      JSON.stringify({
        city: "Demo City",
        country: "US",
        line1: "100 Local Seed Way",
        postalCode: "10001",
        state: "NY"
      }),
      listingRow.unit_amount_cents,
      listingRow.unit_amount_cents + 895,
      seededAt,
      localSeedFixtures.order.publicOrderNumber,
      localSeedFixtures.cart.userId,
      localSeedFixtures.contact.email,
      localSeedFixtures.contact.phone,
      localSeedFixtures.contact.name
    ],
  );

  await db.query(
    "update carts set converted_order_id = $1 where id = $2",
    [orderId, cartId],
  );

  await db.query("delete from order_items where id = $1", [orderItemId]);
  await db.query(
    `
      insert into order_items (
        id,
        order_id,
        listing_id,
        listing_price_variant_id,
        fabric_id,
        quantity,
        unit_amount_cents,
        total_amount_cents,
        currency,
        stripe_product_id,
        stripe_price_id,
        listing_snapshot,
        fabric_snapshot,
        customization_snapshot,
        customization_asset_id,
        production_notes
      ) values ($1, $2, $3, $4, $5, 1, $6, $6, 'usd', $7, $8, $9, $10, $11, $12, $13)
    `,
    [
      orderItemId,
      orderId,
      listingRow.listing_id,
      listingRow.price_variant_id,
      listingRow.fabric_id,
      listingRow.unit_amount_cents,
      listingRow.stripe_product_id,
      listingRow.stripe_price_id,
      JSON.stringify({
        slug: "local-seed-classic-graduation-stole",
        title: "Classic Graduation Stole"
      }),
      JSON.stringify({
        colorName: "Navy",
        name: "Local Seed Navy Satin",
        sku: "LOCAL-SEED-NAVY-SATIN"
      }),
      JSON.stringify({
        imageAssetId: assetId,
        line1: "Class of 2026",
        line2: "Kapchi Demo",
        trim: "Local Gold Trim"
      }),
      assetId,
      "Local seed order. Safe to delete.",
    ],
  );

  await db.query(
    "delete from fabric_reservations where cart_item_id = $1 or order_item_id = $2",
    [cartItemId, orderItemId],
  );

  await db.query(
    `
      insert into fabric_reservations (
        fabric_id,
        cart_id,
        cart_item_id,
        order_id,
        order_item_id,
        quantity,
        status,
        expires_at
      ) values ($1, $2, $3, $4, $5, 1, 'converted', $6)
    `,
    [listingRow.fabric_id, cartId, cartItemId, orderId, orderItemId, seededAt],
  );

  await db.query(
    "delete from order_events where order_id = $1 and event_type = 'local_seed.created'",
    [orderId],
  );

  await db.query(
    `
      insert into order_events (
        order_id,
        actor_type,
        actor_id,
        event_type,
        from_value,
        to_value,
        metadata
      ) values ($1, 'system', 'local-seed', 'local_seed.created', null, 'queued', $2)
    `,
    [orderId, JSON.stringify({ source: "db:seed:local" })],
  );

  await db.query(
    `
      with conversation as (
        insert into order_conversations (
          order_id,
          thread_key,
          status,
          admin_unread,
          last_message_at,
          last_admin_message_at
        ) values (
          $1::uuid,
          'kapchi-order:' || $1::uuid::text,
          'awaiting_customer',
          false,
          $3,
          $3
        )
        on conflict (order_id) do update set
          status = excluded.status,
          admin_unread = excluded.admin_unread,
          last_message_at = excluded.last_message_at,
          last_admin_message_at = excluded.last_admin_message_at,
          resolved_at = null,
          resolved_by_user_id = null,
          version = order_conversations.version + 1
        returning id
      )
      insert into order_messages (
        order_id,
        conversation_id,
        sender_type,
        sender_user_id,
        channel,
        direction,
        status,
        to_address,
        from_address,
        subject,
        body,
        provider,
        provider_message_id,
        sent_at
      ) select
        $1::uuid,
        conversation.id,
        'system',
        'local-seed',
        'email',
        'outbound',
        'sent',
        $4,
        'support@example.test',
        'Local seed order confirmation',
        'This is fake local seed data for development only.',
        'local-seed',
        $2,
        $3
      from conversation
      on conflict (provider, provider_message_id)
      where provider is not null and provider_message_id is not null
      do update set
        status = excluded.status,
        body = excluded.body,
        sent_at = excluded.sent_at
    `,
    [orderId, `local-seed-${orderId}`, seededAt, localSeedFixtures.contact.email],
  );
}

export async function seedLocalDatabase(pool: Pool) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await seedFonts(client);
    await seedTrims(client);
    await seedFabricInventory(client);

    for (const listing of seedListings) {
      await seedListing(client, listing);
    }

    await seedCartAndOrder(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function runSeedLocal() {
  const databaseUrl = process.env.DATABASE_URL;
  assertSafeLocalSeedTarget(databaseUrl);

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: Number(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000,
    ),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30000),
    max: 1
  });

  try {
    await seedLocalDatabase(pool);
    console.log("Seeded local Kapchi PostgreSQL data.");
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  runSeedLocal().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Failed to seed local data.";
    console.error(message);
    process.exitCode = 1;
  });
}
