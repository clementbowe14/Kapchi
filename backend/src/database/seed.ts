import { config as loadDotEnv } from "dotenv";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

loadDotEnv();

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

type SeedListing = {
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

const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const seededAt = new Date("2026-01-01T00:00:00.000Z");

const seedListings: SeedListing[] = [
  {
    basePriceCents: 4500,
    description:
      "Local seed graduation stole with editable text, image, trim, and fabric options.",
    imageAlt: "Local seed navy graduation stole preview",
    imageUrl: "https://example.test/kapchi-local-seed/navy-stole.png",
    listingType: "graduation_stole",
    priceVariants: [
      {
        customizationKind: "blank",
        stripePriceId: "price_local_seed_stole_blank",
        unitAmountCents: 4500,
        variantKey: "blank"
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

async function seedFabrics(db: Queryable) {
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
        ('LOCAL-SEED-NAVY-SATIN', 'Local Seed Navy Satin', 'Navy', '#12335B', 'Satin', 'active', 40, 1, 3),
        ('LOCAL-SEED-GOLD-SATIN', 'Local Seed Gold Satin', 'Gold', '#D4AF37', 'Satin', 'active', 30, 0, 2)
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
  );
}

async function seedListing(db: Queryable, listing: SeedListing) {
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
        stripe_product_id = excluded.stripe_product_id,
        default_stripe_price_id = excluded.default_stripe_price_id,
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
    `,
    [listingRow.id, listing.imageUrl, listing.imageAlt],
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
        ) values ($1, $2, null, $3, $4, 'usd', $5, $6, true)
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
}

async function seedCartAndOrder(db: Queryable) {
  const cartId = "00000000-0000-4000-8000-000000000053";
  const orderId = "00000000-0000-4000-8000-000000000153";
  const assetId = "00000000-0000-4000-8000-000000000061";
  const cartItemId = "00000000-0000-4000-8000-000000000253";
  const orderItemId = "00000000-0000-4000-8000-000000000353";

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
      ) values ($1, 'user_local_seed_demo', null, 'converted', 'usd', $2, null, $3)
      on conflict (id) do update set
        user_id = excluded.user_id,
        guest_token_hash = excluded.guest_token_hash,
        status = excluded.status,
        currency = excluded.currency,
        subtotal_cents = excluded.subtotal_cents,
        expires_at = excluded.expires_at
    `,
    [cartId, listingRow.unit_amount_cents, seededAt],
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
        'local-seed/uploads/class-of-2026.png',
        'https://example.test/kapchi-local-seed/uploads/class-of-2026.png',
        'image/png',
        2048,
        'local-seed-checksum',
        'private',
        'customization_image',
        'attached',
        $2,
        $3,
        $4
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
        imageAssetId: assetId,
        line1: "Class of 2026",
        line2: "Kapchi Demo",
        trim: "Local Gold Trim"
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
        'LOCAL-SEED-1001',
        'user_local_seed_demo',
        $2,
        'paid',
        'paid',
        'queued',
        'local-demo@example.test',
        '+1555010053',
        'email',
        'Local Seed Customer',
        $3,
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
      seededAt
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
      insert into order_messages (
        order_id,
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
      ) values (
        $1,
        'system',
        'local-seed',
        'email',
        'outbound',
        'sent',
        'local-demo@example.test',
        'support@example.test',
        'Local seed order confirmation',
        'This is fake local seed data for development only.',
        'local-seed',
        $2,
        $3
      )
      on conflict (provider, provider_message_id)
      where provider is not null and provider_message_id is not null
      do update set
        status = excluded.status,
        body = excluded.body,
        sent_at = excluded.sent_at
    `,
    [orderId, `local-seed-${orderId}`, seededAt],
  );
}

export async function seedLocalDatabase(pool: Pool) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await seedFonts(client);
    await seedTrims(client);
    await seedFabrics(client);

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
