import type { QueryResultRow } from "pg";
import {
  expectedCurrentUsdAnalytics,
  fixtureAssets,
  fixtureCarts,
  fixtureExports,
  fixtureFulfillments,
  fixtureIdentities,
  fixtureOrder,
  fixtureOrders,
  fixtureShipments,
  fixtureTimes,
  safeShippingAddress,
  type FixtureOrder
} from "./admin-workflows.js";
import {
  assertNoUnownedFixtureDependents,
  recordFixtureOwnership,
  upsertOwnedFixture,
  type FixtureOwnership
} from "./ownership.js";
import {
  FixtureSafetyError,
  fingerprint,
  sha256,
  type FixtureQueryable
} from "./safety.js";
import {
  seedOperationalFixtures,
  type OperationalFixtureReferences,
  type OperationalOwnedRow
} from "./operational.js";

export type CoreSeedListing = {
  basePriceCents: number;
  description: string;
  imageAlt: string;
  imageUrl: string;
  listingType: "graduation_stole" | "accessory" | "other";
  priceVariants: readonly {
    customizationKind: string;
    stripePriceId: string;
    unitAmountCents: number;
    variantKey: string;
  }[];
  requiresFabric: boolean;
  slug: string;
  stripeProductId: string;
  subtitle: string;
  title: string;
};

export type CoreSeedFabric = {
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

const ids = {
  listings: [
    "85000000-0000-4000-8000-000000010001",
    "85000000-0000-4000-8000-000000010002"
  ],
  listingImages: [
    "85000000-0000-4000-8000-000000010101",
    "85000000-0000-4000-8000-000000010102"
  ],
  listingAssets: [
    "85000000-0000-4000-8000-000000010201",
    "85000000-0000-4000-8000-000000010202"
  ],
  fabrics: [
    "85000000-0000-4000-8000-000000011001",
    "85000000-0000-4000-8000-000000011002"
  ],
  fabricAssets: [
    "85000000-0000-4000-8000-000000011101",
    "85000000-0000-4000-8000-000000011102"
  ],
  fonts: [
    "85000000-0000-4000-8000-000000012001",
    "85000000-0000-4000-8000-000000012002",
    "85000000-0000-4000-8000-000000012003"
  ],
  trims: [
    "85000000-0000-4000-8000-000000013001",
    "85000000-0000-4000-8000-000000013002",
    "85000000-0000-4000-8000-000000013003"
  ],
  customizationBase: 14_000,
  variantBase: 15_000,
  productionBase: 16_000,
  fulfillmentItemBase: 17_000,
  shipmentItemBase: 18_000,
  auditEvent: "85000000-0000-4000-8000-000000019001",
  exportReceipt: "85000000-0000-4000-8000-000000019002"
} as const;

function sequenceId(sequence: number) {
  return `85000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

async function ownedWrite(
  db: FixtureQueryable,
  ownership: FixtureOwnership,
  collisionSql: string,
  collisionValues: unknown[],
  sql: string,
  values: unknown[],
) {
  await upsertOwnedFixture(db, {
    ...ownership,
    collisionSql,
    collisionValues,
    write: () => db.query(sql, values)
  });
}

async function validateCustomizationDependencies(db: FixtureQueryable) {
  const result = await db.query<
    QueryResultRow & {
      default_max_chars: number | null;
      kind: string;
      requires_image: boolean;
      requires_text: boolean;
      requires_trim: boolean;
    }
  >(
    `select kind::text, requires_text, requires_image, requires_trim, default_max_chars
       from customization_sets order by kind`,
  );
  const expected = new Map([
    ["blank", [false, false, false, null]],
    ["text_short", [true, false, false, 40]],
    ["text_long", [true, false, false, 120]],
    ["text_image", [true, true, false, 120]],
    ["text_image_trim", [true, true, true, 120]]
  ] as const);
  if (result.rows.length !== expected.size) {
    throw new FixtureSafetyError("FIXTURE_DEPENDENCY_DRIFT", "customization-sets", "customization_sets");
  }
  for (const row of result.rows) {
    const contract = expected.get(
      row.kind as "blank" | "text_short" | "text_long" | "text_image" | "text_image_trim",
    );
    if (
      !contract ||
      row.requires_text !== contract[0] ||
      row.requires_image !== contract[1] ||
      row.requires_trim !== contract[2] ||
      row.default_max_chars !== contract[3]
    ) {
      throw new FixtureSafetyError("FIXTURE_DEPENDENCY_DRIFT", `customization.${row.kind}`, "customization_sets");
    }
  }
}

async function validAttestation(
  db: FixtureQueryable,
  listing: CoreSeedListing,
  variant: CoreSeedListing["priceVariants"][number],
  expectedStripeAccountId: string | undefined,
) {
  if (!expectedStripeAccountId) return null;
  const fixtureKey = `catalog.variant.${listing.slug}.${variant.variantKey}`;
  const pricingFingerprint = fingerprint({
    active: true,
    currency: "usd",
    customizationKind: variant.customizationKind,
    listingSlug: listing.slug,
    unitAmountCents: variant.unitAmountCents,
    variantKey: variant.variantKey
  });
  const result = await db.query<
    QueryResultRow & { stripe_price_id: string; stripe_product_id: string }
  >(
    `select attestations.stripe_product_id, attestations.stripe_price_id
       from kapchi_fixture.catalog_attestations attestations
       join listings on listings.slug = $3
       join listing_price_variants variants
         on variants.listing_id = listings.id and variants.variant_key = $4
        and variants.active and variants.replaced_at is null
      where attestations.fixture_key = $1 and attestations.marker_id = $2
        and attestations.livemode = false and attestations.listing_slug = $3
        and attestations.variant_key = $4 and attestations.customization_kind = $5
        and attestations.unit_amount_cents = $6 and attestations.currency = 'usd'
        and attestations.pricing_fingerprint = $7
        and attestations.stripe_account_id = $8
        and variants.stripe_product_id = attestations.stripe_product_id
        and variants.stripe_price_id = attestations.stripe_price_id
        and variants.unit_amount_cents = attestations.unit_amount_cents
        and variants.currency = attestations.currency
        and listings.stripe_product_id = attestations.stripe_product_id
        and listings.base_price_cents = $9 and listings.currency = 'usd'
        and ($10::boolean = false
          or listings.default_stripe_price_id = attestations.stripe_price_id)`,
    [
      fixtureKey,
      "85d4a1ab-5a3c-4edf-a8e9-000000000085",
      listing.slug,
      variant.variantKey,
      variant.customizationKind,
      variant.unitAmountCents,
      pricingFingerprint,
      expectedStripeAccountId,
      listing.basePriceCents,
      variant === listing.priceVariants[0]
    ],
  );
  return result.rows[0] ?? null;
}

async function seedCatalog(
  db: FixtureQueryable,
  listings: readonly CoreSeedListing[],
  fabrics: readonly CoreSeedFabric[],
  expectedStripeAccountId?: string,
) {
  const fonts = [
    { name: "Local Serif", css: "Georgia, serif", preview: "Class of 2026" },
    { name: "Local Sans", css: "Inter, Arial, sans-serif", preview: "Kapchi Local" },
    { name: "Local Script", css: '"Brush Script MT", cursive', preview: "Congrats!" }
  ];
  for (const [index, font] of fonts.entries()) {
    const id = ids.fonts[index]!;
    await ownedWrite(db, {
      fixtureKey: `catalog.font.${font.name}`, tableName: "font_options", rowId: id,
      naturalKey: { name: font.name }, canonical: { ...font, active: true }
    }, "select id::text from font_options where id = $1 or name = $2", [id, font.name],
    `insert into font_options (id, name, css_family, preview_text, active)
     values ($1, $2, $3, $4, true)
     on conflict (id) do update set css_family=excluded.css_family, preview_text=excluded.preview_text, active=true`,
    [id, font.name, font.css, font.preview]);
  }

  const trims = [
    { name: "Local Gold Trim", color: "Gold", hex: "#D4AF37", price: 600 },
    { name: "Local White Trim", color: "White", hex: "#FFFFFF", price: 400 },
    { name: "Local Crimson Trim", color: "Crimson", hex: "#B11226", price: 500 }
  ];
  for (const [index, trim] of trims.entries()) {
    const id = ids.trims[index]!;
    await ownedWrite(db, {
      fixtureKey: `catalog.trim.${trim.name}`, tableName: "trim_options", rowId: id,
      naturalKey: { name: trim.name }, canonical: { ...trim, active: true }
    }, "select id::text from trim_options where id = $1 or name = $2", [id, trim.name],
    `insert into trim_options (id, name, color_name, color_hex, price_delta_cents, active)
     values ($1, $2, $3, $4, $5, true)
     on conflict (id) do update set color_name=excluded.color_name, color_hex=excluded.color_hex,
       price_delta_cents=excluded.price_delta_cents, active=true`,
    [id, trim.name, trim.color, trim.hex, trim.price]);
  }

  for (const [index, fabric] of fabrics.entries()) {
    const id = ids.fabrics[index]!;
    await ownedWrite(db, {
      fixtureKey: `catalog.fabric.${fabric.sku}`, tableName: "fabrics", rowId: id,
      naturalKey: { sku: fabric.sku }, canonical: fabric
    }, "select id::text from fabrics where id = $1 or sku = $2", [id, fabric.sku],
    `insert into fabrics (id, sku, name, color_name, color_hex, material, status,
       quantity_on_hand, quantity_reserved, quantity_sold)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set name=excluded.name, color_name=excluded.color_name,
       color_hex=excluded.color_hex, material=excluded.material, status=excluded.status,
       quantity_on_hand=excluded.quantity_on_hand, quantity_reserved=excluded.quantity_reserved,
       quantity_sold=excluded.quantity_sold`,
    [id, fabric.sku, fabric.name, fabric.colorName, fabric.colorHex, fabric.material,
      fabric.status, fabric.quantityOnHand, fabric.quantityReserved, fabric.quantitySold]);
    const assetId = ids.fabricAssets[index]!;
    const storageKey = `fixture-only/fabrics/${fabric.sku.toLowerCase()}.webp`;
    await ownedWrite(db, {
      fixtureKey: `catalog.fabric-asset.${fabric.sku}`, tableName: "assets", rowId: assetId,
      naturalKey: { provider: "local_public", storageKey },
      canonical: { fabricId: id, storageKey, url: fabric.imageUrl }
    }, "select id::text from assets where id=$1 or (provider='local_public' and storage_key=$2)",
    [assetId, storageKey],
    `insert into assets (id, provider, storage_key, url, content_type, byte_size, visibility,
       context, status, fabric_id, metadata)
     values ($1,'local_public',$2,$3,'image/webp',1,'public_catalog','fabric_image','uploaded',$4,$5::jsonb)
     on conflict (id) do update set url=excluded.url, fabric_id=excluded.fabric_id, metadata=excluded.metadata`,
    [assetId, storageKey, fabric.imageUrl, id, JSON.stringify({ alt: fabric.imageAlt, fixture: true })]);
  }

  const customizationRows = await db.query<QueryResultRow & { id: string; kind: string; default_max_chars: number | null; requires_image: boolean }>(
    "select id::text, kind::text, default_max_chars, requires_image from customization_sets",
  );
  const customizationByKind = new Map(customizationRows.rows.map((row) => [row.kind, row]));

  for (const [listingIndex, listing] of listings.entries()) {
    const listingId = ids.listings[listingIndex]!;
    const attestations = [];
    for (const variant of listing.priceVariants) {
      attestations.push(
        await validAttestation(db, listing, variant, expectedStripeAccountId),
      );
    }
    const attestedProductIds = new Set(attestations.filter(Boolean).map((entry) => entry!.stripe_product_id));
    const preserveAttestations = attestations.every(Boolean) && attestedProductIds.size === 1;
    if (!preserveAttestations) {
      await db.query("delete from kapchi_fixture.catalog_attestations where listing_slug = $1", [listing.slug]);
    }
    const productId = preserveAttestations ? attestations[0]!.stripe_product_id : listing.stripeProductId;
    const defaultPriceId = preserveAttestations ? attestations[0]!.stripe_price_id : listing.priceVariants[0]!.stripePriceId;
    await ownedWrite(db, {
      fixtureKey: `catalog.listing.${listing.slug}`, tableName: "listings", rowId: listingId,
      naturalKey: { slug: listing.slug },
      canonical: { ...listing, stripeProductId: productId, defaultStripePriceId: defaultPriceId }
    }, "select id::text from listings where id=$1 or slug=$2", [listingId, listing.slug],
    `insert into listings (id, slug, title, subtitle, description, listing_type, status,
       base_price_cents, currency, requires_fabric, stripe_product_id, default_stripe_price_id)
     values ($1,$2,$3,$4,$5,$6,'active',$7,'usd',$8,$9,$10)
     on conflict (id) do update set title=excluded.title, subtitle=excluded.subtitle,
       description=excluded.description, listing_type=excluded.listing_type, status='active',
       base_price_cents=excluded.base_price_cents, currency='usd', requires_fabric=excluded.requires_fabric,
       stripe_product_id=excluded.stripe_product_id, default_stripe_price_id=excluded.default_stripe_price_id,
       archived_at=null`,
    [listingId, listing.slug, listing.title, listing.subtitle, listing.description,
      listing.listingType, listing.basePriceCents, listing.requiresFabric, productId, defaultPriceId]);

    const imageId = ids.listingImages[listingIndex]!;
    await ownedWrite(db, {
      fixtureKey: `catalog.listing-image.${listing.slug}`, tableName: "listing_images", rowId: imageId,
      naturalKey: { listingId, primary: true }, canonical: { imageUrl: listing.imageUrl, alt: listing.imageAlt }
    }, "select id::text from listing_images where id=$1 or (listing_id=$2 and is_primary)", [imageId, listingId],
    `insert into listing_images (id, listing_id, image_url, alt_text, sort_order, is_primary)
     values ($1,$2,$3,$4,0,true)
     on conflict (id) do update set image_url=excluded.image_url, alt_text=excluded.alt_text, sort_order=0, is_primary=true`,
    [imageId, listingId, listing.imageUrl, listing.imageAlt]);

    const listingAssetId = ids.listingAssets[listingIndex]!;
    const listingStorage = `fixture-only/listings/${listing.slug}.webp`;
    await ownedWrite(db, {
      fixtureKey: `catalog.listing-asset.${listing.slug}`, tableName: "assets", rowId: listingAssetId,
      naturalKey: { provider: "local_public", storageKey: listingStorage },
      canonical: { listingId, url: listing.imageUrl }
    }, "select id::text from assets where id=$1 or (provider='local_public' and storage_key=$2)",
    [listingAssetId, listingStorage],
    `insert into assets (id,provider,storage_key,url,content_type,byte_size,visibility,context,status,listing_id,metadata)
     values ($1,'local_public',$2,$3,'image/webp',1,'public_catalog','catalog_listing_image','uploaded',$4,$5::jsonb)
     on conflict (id) do update set url=excluded.url, listing_id=excluded.listing_id, metadata=excluded.metadata`,
    [listingAssetId, listingStorage, listing.imageUrl, listingId, JSON.stringify({ alt: listing.imageAlt, fixture: true })]);

    if (listing.requiresFabric) {
      for (const [fabricIndex, fabricId] of ids.fabrics.entries()) {
        const rowId = `${listingId}:${fabricId}`;
        await ownedWrite(db, {
          fixtureKey: `catalog.listing-fabric.${listing.slug}.${fabricIndex}`, tableName: "listing_fabrics", rowId,
          naturalKey: { listingId, fabricId }, canonical: { active: true, default: fabricIndex === 0, sortOrder: fabricIndex }
        }, "select listing_id::text || ':' || fabric_id::text as id from listing_fabrics where listing_id=$1 and fabric_id=$2",
        [listingId, fabricId],
        `insert into listing_fabrics (listing_id,fabric_id,active,is_default,sort_order)
         values ($1,$2,true,$3,$4)
         on conflict (listing_id,fabric_id) do update set active=true,is_default=excluded.is_default,sort_order=excluded.sort_order`,
        [listingId, fabricId, fabricIndex === 0, fabricIndex]);
      }
    }

    for (const [variantIndex, variant] of listing.priceVariants.entries()) {
      const definition = customizationByKind.get(variant.customizationKind);
      if (!definition) throw new FixtureSafetyError("FIXTURE_DEPENDENCY_DRIFT", variant.customizationKind, "customization_sets");
      const lcsId = sequenceId(ids.customizationBase + listingIndex * 100 + variantIndex);
      await ownedWrite(db, {
        fixtureKey: `catalog.customization.${listing.slug}.${variant.variantKey}`,
        tableName: "listing_customization_sets", rowId: lcsId,
        naturalKey: { listingId, customizationSetId: definition.id },
        canonical: { enabled: true, priceDelta: variant.unitAmountCents - listing.basePriceCents, sortOrder: variantIndex }
      }, "select id::text from listing_customization_sets where id=$1 or (listing_id=$2 and customization_set_id=$3)",
      [lcsId, listingId, definition.id],
      `insert into listing_customization_sets (id,listing_id,customization_set_id,enabled,price_delta_cents,max_chars,min_chars,image_max_bytes,sort_order)
       values ($1,$2,$3,true,$4,$5,0,$6,$7)
       on conflict (id) do update set enabled=true,price_delta_cents=excluded.price_delta_cents,
         max_chars=excluded.max_chars,min_chars=0,image_max_bytes=excluded.image_max_bytes,sort_order=excluded.sort_order`,
      [lcsId, listingId, definition.id, variant.unitAmountCents - listing.basePriceCents,
        definition.default_max_chars, definition.requires_image ? 5_242_880 : null, variantIndex]);

      const mapping = preserveAttestations ? attestations[variantIndex]! : null;
      const variantId = sequenceId(ids.variantBase + listingIndex * 100 + variantIndex);
      await ownedWrite(db, {
        fixtureKey: `catalog.variant.${listing.slug}.${variant.variantKey}`, tableName: "listing_price_variants", rowId: variantId,
        naturalKey: { listingId, variantKey: variant.variantKey },
        canonical: { listingId, lcsId, amount: variant.unitAmountCents, currency: "usd", active: true }
      }, "select id::text from listing_price_variants where id=$1 or (listing_id=$2 and variant_key=$3 and active)",
      [variantId, listingId, variant.variantKey],
      `insert into listing_price_variants (id,listing_id,listing_customization_set_id,variant_key,unit_amount_cents,currency,stripe_product_id,stripe_price_id,active)
       values ($1,$2,$3,$4,$5,'usd',$6,$7,true)
       on conflict (id) do update set listing_customization_set_id=excluded.listing_customization_set_id,
         unit_amount_cents=excluded.unit_amount_cents,currency='usd',stripe_product_id=excluded.stripe_product_id,
         stripe_price_id=excluded.stripe_price_id,active=true,replaced_at=null`,
      [variantId, listingId, lcsId, variant.variantKey, variant.unitAmountCents,
        mapping?.stripe_product_id ?? listing.stripeProductId,
        mapping?.stripe_price_id ?? variant.stripePriceId]);

      for (const fontId of ids.fonts) {
        const rowId = `${lcsId}:${fontId}`;
        await ownedWrite(db, {
          fixtureKey: `catalog.customization-font.${lcsId}.${fontId}`, tableName: "listing_customization_fonts", rowId,
          naturalKey: { lcsId, fontId }, canonical: { lcsId, fontId }
        }, "select listing_customization_set_id::text || ':' || font_option_id::text as id from listing_customization_fonts where listing_customization_set_id=$1 and font_option_id=$2",
        [lcsId, fontId], "insert into listing_customization_fonts values ($1,$2) on conflict do nothing", [lcsId, fontId]);
      }
      for (const trimId of ids.trims) {
        const rowId = `${lcsId}:${trimId}`;
        await ownedWrite(db, {
          fixtureKey: `catalog.customization-trim.${lcsId}.${trimId}`, tableName: "listing_customization_trims", rowId,
          naturalKey: { lcsId, trimId }, canonical: { lcsId, trimId }
        }, "select listing_customization_set_id::text || ':' || trim_option_id::text as id from listing_customization_trims where listing_customization_set_id=$1 and trim_option_id=$2",
        [lcsId, trimId], "insert into listing_customization_trims values ($1,$2) on conflict do nothing", [lcsId, trimId]);
      }

      if (listing.listingType === "graduation_stole") {
        const minimum = [3, 5, 7, 10, 14][variantIndex] ?? 3;
        for (const [priorityIndex, priority] of ["standard", "rush"].entries()) {
          const ruleId = sequenceId(ids.productionBase + variantIndex * 10 + priorityIndex);
          const rule = {
            id: ruleId, listingId, lcsId, priority,
            minimum: priority === "standard" ? minimum : Math.max(1, minimum - 2),
            maximum: priority === "standard" ? minimum + 3 : minimum,
            default: priority === "standard", sortOrder: priorityIndex
          };
          await ownedWrite(db, {
            fixtureKey: `catalog.production.${variant.variantKey}.${priority}`, tableName: "listing_production_estimate_rules",
            rowId: ruleId, naturalKey: { lcsId, priority, revision: 1 }, canonical: rule, immutable: true
          }, "select id::text from listing_production_estimate_rules where id=$1 or (listing_customization_set_id=$2 and priority_code=$3 and revision=1)",
          [ruleId, lcsId, priority],
          `insert into listing_production_estimate_rules
             (id,listing_id,listing_customization_set_id,priority_code,label,minimum_business_days,maximum_business_days,revision,is_default,active,sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,1,$8,true,$9) on conflict (id) do nothing`,
          [ruleId, listingId, lcsId, priority, priority === "standard" ? "Standard" : "Rush",
            rule.minimum, rule.maximum, rule.default, rule.sortOrder]);
        }
      }
    }
  }
}

export async function seedCatalogFixtures(
  db: FixtureQueryable,
  input: {
    expectedStripeAccountId?: string;
    fabrics: readonly CoreSeedFabric[];
    listings: readonly CoreSeedListing[];
  },
) {
  await assertNoUnownedFixtureDependents(db);
  await validateCustomizationDependencies(db);
  await seedCatalog(
    db,
    input.listings,
    input.fabrics,
    input.expectedStripeAccountId,
  );
  return {
    fabrics: input.fabrics.length,
    listings: input.listings.length,
    priceVariants: input.listings.reduce(
      (total, listing) => total + listing.priceVariants.length,
      0,
    ),
  };
}

async function seedIdentities(db: FixtureQueryable) {
  for (const identity of fixtureIdentities) {
    if (identity.userId) {
      let subject = identity.authSubject!;
      if (identity.key === "identity.admin") {
        const binding = await db.query<{ subject_hash: string }>(
          "select subject_hash from kapchi_fixture.admin_bindings where fixture_user_id=$1",
          [identity.userId],
        );
        if (binding.rows[0]) {
          const current = await db.query<{ auth_subject: string }>("select auth_subject from users where id=$1", [identity.userId]);
          const currentSubject = current.rows[0]?.auth_subject;
          if (!currentSubject || sha256(currentSubject) !== binding.rows[0].subject_hash) {
            throw new FixtureSafetyError("FIXTURE_OWNERSHIP_COLLISION", identity.key, "users");
          }
          subject = currentSubject;
        }
      }
      await ownedWrite(db, {
        fixtureKey: `${identity.key}.user`, tableName: "users", rowId: identity.userId,
        naturalKey: { provider: "clerk", subject },
        canonical: { subject, email: identity.email, phone: identity.phone, name: identity.displayName }
      }, "select id::text from users where id=$1 or (auth_provider='clerk' and auth_subject=$2)",
      [identity.userId, subject],
      `insert into users (id,auth_provider,auth_subject,email,phone,display_name)
       values ($1,'clerk',$2,$3,$4,$5)
       on conflict (id) do update set auth_subject=excluded.auth_subject,email=excluded.email,
         phone=excluded.phone,display_name=excluded.display_name,disabled_at=null`,
      [identity.userId, subject, identity.email ?? null, identity.phone ?? null, identity.displayName]);
    }
    if (identity.customerId) {
      await ownedWrite(db, {
        fixtureKey: `${identity.key}.customer`, tableName: "customers", rowId: identity.customerId,
        naturalKey: { userId: identity.userId ?? null, email: identity.email ?? null, phone: identity.phone ?? null },
        canonical: identity
      }, "select id::text from customers where id=$1 or ($2::uuid is not null and user_id=$2) or ($2::uuid is null and email is not distinct from $3 and phone is not distinct from $4)",
      [identity.customerId, identity.userId ?? null, identity.email ?? null, identity.phone ?? null],
      `insert into customers (id,user_id,email,phone,full_name,preferred_contact_method,stripe_customer_id,first_seen_at)
       values ($1,$2,$3,$4,$5,$6,null,$7)
       on conflict (id) do update set user_id=excluded.user_id,email=excluded.email,phone=excluded.phone,
         full_name=excluded.full_name,preferred_contact_method=excluded.preferred_contact_method`,
      [identity.customerId, identity.userId ?? null, identity.email ?? null, identity.phone ?? null,
        identity.displayName, identity.preferredContactMethod ?? null, fixtureTimes.previousOrder]);
    }
    if (identity.contactId && identity.customerId) {
      await ownedWrite(db, {
        fixtureKey: `${identity.key}.contact`, tableName: "customer_contacts", rowId: identity.contactId,
        naturalKey: { customerId: identity.customerId, primary: true },
        canonical: { email: identity.email, phone: identity.phone, acceptsMarketing: false }
      }, "select id::text from customer_contacts where id=$1 or (customer_id=$2 and is_primary)",
      [identity.contactId, identity.customerId],
      `insert into customer_contacts (id,customer_id,label,contact_name,email,phone,preferred_contact_method,is_primary,accepts_marketing)
       values ($1,$2,'Fixture primary',$3,$4,$5,$6,true,false)
       on conflict (id) do update set contact_name=excluded.contact_name,email=excluded.email,
         phone=excluded.phone,preferred_contact_method=excluded.preferred_contact_method,is_primary=true,accepts_marketing=false`,
      [identity.contactId, identity.customerId, identity.displayName, identity.email ?? null,
        identity.phone ?? null, identity.preferredContactMethod ?? null]);
    }
  }
}

function identityForOrder(order: FixtureOrder) {
  const key = `identity.${order.customerKey}`;
  const identity = fixtureIdentities.find((entry) => entry.key === key);
  if (!identity) throw new Error(`Missing identity ${key}`);
  return identity;
}

async function catalogReference(db: FixtureQueryable, order: FixtureOrder) {
  const listingIndex = order.unitAmountCents === 1800 || order.currency === "eur" ? 1 : 0;
  const listingId = ids.listings[listingIndex]!;
  const variant = await db.query<QueryResultRow & { id: string; listing_customization_set_id: string; stripe_price_id: string; stripe_product_id: string }>(
    `select id::text, listing_customization_set_id::text, stripe_price_id, stripe_product_id
       from listing_price_variants where listing_id=$1 and variant_key=$2 and active`,
    [listingId, order.variantKey],
  );
  const row = variant.rows[0];
  if (!row) throw new FixtureSafetyError("FIXTURE_DEPENDENCY_DRIFT", order.key, "listing_price_variants");
  return { listingId, ...row, fabricId: listingIndex === 0 ? ids.fabrics[0]! : null };
}

async function seedCartsAssetsAndOrders(db: FixtureQueryable) {
  const returning = fixtureIdentities.find((entry) => entry.key === "identity.returning")!;
  const activeReference = await catalogReference(db, fixtureOrder("production"));
  await ownedWrite(db, {
    fixtureKey: "workflow.cart.active", tableName: "carts", rowId: fixtureCarts.active.id,
    naturalKey: { authenticatedUserId: returning.userId, status: "active" },
    canonical: { status: "active", subtotal: 6000, expiresAt: fixtureTimes.activeReservationExpiresAt }
  }, "select id::text from carts where id=$1 or (authenticated_user_id=$2 and status='active')",
  [fixtureCarts.active.id, returning.userId],
  `insert into carts (id,user_id,authenticated_user_id,customer_id,customer_contact_id,status,currency,subtotal_cents,expires_at,revision)
   values ($1,$2,$3,$4,$5,'active','usd',6000,$6,0)
   on conflict (id) do update set user_id=excluded.user_id,authenticated_user_id=excluded.authenticated_user_id,
     customer_id=excluded.customer_id,customer_contact_id=excluded.customer_contact_id,status='active',currency='usd',
     subtotal_cents=6000,converted_order_id=null,expires_at=excluded.expires_at,revision=0`,
  [fixtureCarts.active.id, returning.authSubject, returning.userId, returning.customerId,
    returning.contactId, fixtureTimes.activeReservationExpiresAt]);

  await ownedWrite(db, {
    fixtureKey: "workflow.asset.artwork", tableName: "assets", rowId: fixtureAssets.artwork.id,
    naturalKey: { provider: "fixture_unsupported", storageKey: fixtureAssets.artwork.storageKey },
    canonical: fixtureAssets.artwork
  }, "select id::text from assets where id=$1 or (provider='fixture_unsupported' and storage_key=$2)",
  [fixtureAssets.artwork.id, fixtureAssets.artwork.storageKey],
  `insert into assets (id,provider,storage_key,url,content_type,byte_size,checksum,visibility,context,status,
     authenticated_user_id,created_by_auth_subject,cart_id,listing_id,metadata)
   values ($1,'fixture_unsupported',$2,$3,'image/png',128,'fixture-only-checksum','private','customization_image','attached',
     $4,$5,$6,$7,$8::jsonb)
   on conflict (id) do update set provider='fixture_unsupported',storage_key=excluded.storage_key,url=excluded.url,
     status='attached',authenticated_user_id=excluded.authenticated_user_id,cart_id=excluded.cart_id,listing_id=excluded.listing_id,
     metadata=excluded.metadata`,
  [fixtureAssets.artwork.id, fixtureAssets.artwork.storageKey, fixtureAssets.artwork.url,
    returning.userId, returning.authSubject, fixtureCarts.active.id, activeReference.listingId,
    JSON.stringify({ originalFilename: "fixture-artwork.png", fixture: true })]);

  const estimate = { priorityCode: "standard", label: "Standard", minimumBusinessDays: 10, maximumBusinessDays: 13, revision: 1 };
  await ownedWrite(db, {
    fixtureKey: "workflow.cart-item.active", tableName: "cart_items", rowId: fixtureCarts.active.itemId,
    naturalKey: { cartId: fixtureCarts.active.id, fixture: true },
    canonical: { quantity: 1, amount: 6000, estimate }
  }, "select id::text from cart_items where id=$1", [fixtureCarts.active.itemId],
  `insert into cart_items (id,cart_id,listing_id,listing_customization_set_id,listing_price_variant_id,fabric_id,
     quantity,unit_amount_cents,currency,customization_payload,customization_asset_id,validation_status,
     production_priority_code,production_estimate_snapshot)
   values ($1,$2,$3,$4,$5,$6,1,6000,'usd',$7::jsonb,$8,'valid','standard',$9::jsonb)
   on conflict (id) do update set quantity=1,unit_amount_cents=6000,customization_payload=excluded.customization_payload,
     customization_asset_id=excluded.customization_asset_id,validation_status='valid',production_priority_code='standard',
     production_estimate_snapshot=excluded.production_estimate_snapshot`,
  [fixtureCarts.active.itemId, fixtureCarts.active.id, activeReference.listingId,
    activeReference.listing_customization_set_id, activeReference.id, activeReference.fabricId,
    JSON.stringify({ line1: "Class of 2026", imageAssetId: fixtureAssets.artwork.id }),
    fixtureAssets.artwork.id, JSON.stringify(estimate)]);

  await ownedWrite(db, {
    fixtureKey: "workflow.reservation.active", tableName: "fabric_reservations", rowId: fixtureCarts.active.reservationId,
    naturalKey: { cartItemId: fixtureCarts.active.itemId },
    canonical: { fabricId: activeReference.fabricId, quantity: 1, status: "active", expiresAt: fixtureTimes.activeReservationExpiresAt }
  }, "select id::text from fabric_reservations where id=$1 or cart_item_id=$2", [fixtureCarts.active.reservationId, fixtureCarts.active.itemId],
  `insert into fabric_reservations (id,fabric_id,cart_id,cart_item_id,quantity,status,expires_at)
   values ($1,$2,$3,$4,1,'active',$5)
   on conflict (id) do update set fabric_id=excluded.fabric_id,cart_id=excluded.cart_id,cart_item_id=excluded.cart_item_id,
     quantity=1,status='active',expires_at=excluded.expires_at`,
  [fixtureCarts.active.reservationId, activeReference.fabricId, fixtureCarts.active.id,
    fixtureCarts.active.itemId, fixtureTimes.activeReservationExpiresAt]);

  const queue = fixtureOrder("queue");
  await ownedWrite(db, {
    fixtureKey: "workflow.cart.converted", tableName: "carts", rowId: fixtureCarts.converted.id,
    naturalKey: { convertedOrderId: queue.id }, canonical: { status: "converted", convertedOrderId: queue.id }
  }, "select id::text from carts where id=$1", [fixtureCarts.converted.id],
  `insert into carts (id,user_id,authenticated_user_id,customer_id,customer_contact_id,status,currency,subtotal_cents,converted_order_id,expires_at,revision)
   values ($1,$2,$3,$4,$5,'converted','usd',5000,null,$6,0)
   on conflict (id) do update set status='converted',subtotal_cents=5000,expires_at=excluded.expires_at`,
  [fixtureCarts.converted.id, returning.authSubject, returning.userId, returning.customerId,
    returning.contactId, queue.createdAt]);

  for (const order of fixtureOrders) {
    const identity = identityForOrder(order);
    const reference = await catalogReference(db, order);
    const subtotal = order.unitAmountCents * order.quantity;
    const shipping = order.currency === "usd" ? 895 : 0;
    const total = subtotal + shipping - order.discountCents;
    const cancelledAt = order.status === "cancelled" ? order.createdAt : null;
    const paidAt = order.paymentStatus === "unpaid" || order.paymentStatus === "failed" ? null : order.createdAt;
    const isQueue = order.key === "queue";
    const paymentIntentId = order.key === "partial-refund"
      ? "pi_test_fixture_partial"
      : order.key === "full-refund"
        ? "pi_test_fixture_full"
        : order.key === "failed-refund"
          ? "pi_test_fixture_failed"
          : order.key === "ready"
            ? "pi_test_fixture_manual"
            : order.paymentStatus === "unpaid"
              ? null
              : `pi_test_fixture_${order.key.replaceAll("-", "_")}`;
    await ownedWrite(db, {
      fixtureKey: `workflow.order.${order.key}`, tableName: "orders", rowId: order.id,
      naturalKey: { publicOrderNumber: order.publicOrderNumber }, canonical: order
    }, "select id::text from orders where id=$1 or public_order_number=$2", [order.id, order.publicOrderNumber],
    `insert into orders (id,public_order_number,user_id,authenticated_user_id,customer_id,customer_contact_id,cart_id,
       status,payment_status,fulfillment_status,customer_email,customer_phone,preferred_contact_method,shipping_name,
       shipping_address,shipping_address_status,subtotal_cents,shipping_cents,tax_cents,discount_cents,total_cents,currency,
       stripe_checkout_session_id,stripe_payment_intent_id,stripe_customer_id,paid_at,cancelled_at,created_at,
       fulfillment_queued_at,ready_to_ship_at,shipped_at,completed_at,revision)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,'valid',$16,$17,0,$18,$19,$20,
       null,$21,null,$22,$23,$24,$25,$26,$27,$28,0)
     on conflict (id) do update set status=excluded.status,payment_status=excluded.payment_status,
       fulfillment_status=excluded.fulfillment_status,customer_email=excluded.customer_email,customer_phone=excluded.customer_phone,
       preferred_contact_method=excluded.preferred_contact_method,shipping_name=excluded.shipping_name,
       shipping_address=excluded.shipping_address,shipping_address_status='valid',subtotal_cents=excluded.subtotal_cents,
       shipping_cents=excluded.shipping_cents,tax_cents=0,discount_cents=excluded.discount_cents,total_cents=excluded.total_cents,
       currency=excluded.currency,stripe_checkout_session_id=null,stripe_payment_intent_id=excluded.stripe_payment_intent_id,
       paid_at=excluded.paid_at,cancelled_at=excluded.cancelled_at,fulfillment_queued_at=excluded.fulfillment_queued_at,
       ready_to_ship_at=excluded.ready_to_ship_at,shipped_at=excluded.shipped_at,completed_at=excluded.completed_at`,
    [order.id, order.publicOrderNumber, identity.authSubject ?? null, identity.userId ?? null,
      identity.customerId ?? null, identity.contactId ?? null, isQueue ? fixtureCarts.converted.id : null,
      order.status, order.paymentStatus, order.fulfillmentStatus, identity.email ?? null, identity.phone ?? null,
      identity.preferredContactMethod ?? null, identity.displayName, JSON.stringify(safeShippingAddress),
      subtotal, shipping, order.discountCents, total, order.currency,
      paymentIntentId,
      paidAt, cancelledAt, order.createdAt,
      ["queued","in_progress","ready_to_ship","shipped","delivered"].includes(order.fulfillmentStatus) ? order.createdAt : null,
      ["ready_to_ship","shipped","delivered"].includes(order.fulfillmentStatus) ? order.createdAt : null,
      ["shipped","delivered"].includes(order.fulfillmentStatus) ? order.createdAt : null,
      order.fulfillmentStatus === "delivered" ? order.createdAt : null]);

    const listingTitle = reference.listingId === ids.listings[0] ? "Classic Graduation Stole" : "Gold Honor Cord";
    const productionSnapshot = order.withProductionEstimate ? estimate : null;
    await ownedWrite(db, {
      fixtureKey: `workflow.order-item.${order.key}`, tableName: "order_items", rowId: order.itemId,
      naturalKey: { orderId: order.id, fixture: true }, canonical: { ...order, listingTitle, productionSnapshot }
    }, "select id::text from order_items where id=$1", [order.itemId],
    `insert into order_items (id,order_id,listing_id,listing_price_variant_id,fabric_id,quantity,unit_amount_cents,
       total_amount_cents,currency,stripe_product_id,stripe_price_id,listing_snapshot,fabric_snapshot,
       customization_snapshot,customization_asset_id,production_notes,production_priority_code,
       production_estimate_snapshot,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,
       $16,$17,$18::jsonb,$19)
     on conflict (id) do update set quantity=excluded.quantity,unit_amount_cents=excluded.unit_amount_cents,
       total_amount_cents=excluded.total_amount_cents,currency=excluded.currency,listing_snapshot=excluded.listing_snapshot,
       fabric_snapshot=excluded.fabric_snapshot,customization_snapshot=excluded.customization_snapshot,
       customization_asset_id=excluded.customization_asset_id,production_notes=excluded.production_notes,
       production_priority_code=excluded.production_priority_code,production_estimate_snapshot=excluded.production_estimate_snapshot`,
    [order.itemId, order.id, reference.listingId, reference.id, reference.fabricId, order.quantity,
      order.unitAmountCents, subtotal, order.currency, reference.stripe_product_id, reference.stripe_price_id,
      JSON.stringify({ slug: reference.listingId === ids.listings[0] ? "local-seed-classic-graduation-stole" : "local-seed-gold-honor-cord", title: listingTitle }),
      reference.fabricId ? JSON.stringify({ sku: "LOCAL-SEED-NAVY-SATIN", name: "Local Seed Navy Satin" }) : null,
      JSON.stringify(order.withArtwork ? { imageAssetId: fixtureAssets.artwork.id, line1: "Class of 2026" } : {}),
      order.withArtwork ? fixtureAssets.artwork.id : null,
      order.withProductionEstimate ? "Synthetic fixture production notes" : null,
      order.withProductionEstimate ? "standard" : null,
      productionSnapshot ? JSON.stringify(productionSnapshot) : null,
      order.createdAt]);
  }

  await db.query("update carts set converted_order_id=$1 where id=$2", [queue.id, fixtureCarts.converted.id]);
  await db.query("update orders set cart_id=$1 where id=$2", [fixtureCarts.converted.id, queue.id]);

  const queueReference = await catalogReference(db, queue);
  await ownedWrite(db, {
    fixtureKey: "workflow.cart-item.converted", tableName: "cart_items", rowId: fixtureCarts.converted.itemId,
    naturalKey: { cartId: fixtureCarts.converted.id, fixture: true }, canonical: { status: "converted", quantity: 1 }
  }, "select id::text from cart_items where id=$1", [fixtureCarts.converted.itemId],
  `insert into cart_items (id,cart_id,listing_id,listing_customization_set_id,listing_price_variant_id,fabric_id,
     quantity,unit_amount_cents,currency,customization_payload,validation_status,production_priority_code,production_estimate_snapshot)
   values ($1,$2,$3,$4,$5,$6,1,5000,'usd',$7::jsonb,'valid','standard',$8::jsonb)
   on conflict (id) do update set validation_status='valid'`,
  [fixtureCarts.converted.itemId, fixtureCarts.converted.id, queueReference.listingId,
    queueReference.listing_customization_set_id, queueReference.id, queueReference.fabricId,
    JSON.stringify({ line1: "Fixture Graduate" }), JSON.stringify(estimate)]);
  await ownedWrite(db, {
    fixtureKey: "workflow.reservation.converted", tableName: "fabric_reservations", rowId: fixtureCarts.converted.reservationId,
    naturalKey: { orderItemId: queue.itemId }, canonical: { status: "converted", quantity: 1 }
  }, "select id::text from fabric_reservations where id=$1 or order_item_id=$2", [fixtureCarts.converted.reservationId, queue.itemId],
  `insert into fabric_reservations (id,fabric_id,cart_id,cart_item_id,order_id,order_item_id,quantity,status,expires_at)
   values ($1,$2,$3,$4,$5,$6,1,'converted',$7)
   on conflict (id) do update set order_id=excluded.order_id,order_item_id=excluded.order_item_id,status='converted'`,
  [fixtureCarts.converted.reservationId, queueReference.fabricId, fixtureCarts.converted.id,
    fixtureCarts.converted.itemId, queue.id, queue.itemId, queue.createdAt]);
}

async function seedFulfillmentAndShipping(db: FixtureQueryable) {
  const definitions = [
    ["queue", fixtureFulfillments.queue, "queued", 1],
    ["production", fixtureFulfillments.production, "in_progress", 1],
    ["ready", fixtureFulfillments.ready, "ready_to_ship", 1],
    ["partial-shipment", fixtureFulfillments.partial, "partially_shipped", 1],
    ["delivered", fixtureFulfillments.delivered, "completed", 1]
  ] as const;
  for (const [index, [orderKey, fulfillmentId, status, quantity]] of definitions.entries()) {
    const order = fixtureOrder(orderKey);
    const timestamp = order.createdAt;
    await ownedWrite(db, {
      fixtureKey: `workflow.fulfillment.${orderKey}`, tableName: "order_fulfillments", rowId: fulfillmentId,
      naturalKey: { orderId: order.id, number: 1 }, canonical: { status, quantity }
    }, "select id::text from order_fulfillments where id=$1 or (order_id=$2 and fulfillment_number=1)",
    [fulfillmentId, order.id],
    `insert into order_fulfillments (id,order_id,fulfillment_number,status,ready_to_ship_at,shipped_at,completed_at,
       order_snapshot,shipping_name_snapshot,shipping_address_snapshot,metadata,created_at)
     values ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11)
     on conflict (id) do update set status=excluded.status,ready_to_ship_at=excluded.ready_to_ship_at,
       shipped_at=excluded.shipped_at,completed_at=excluded.completed_at,order_snapshot=excluded.order_snapshot,
       shipping_address_snapshot=excluded.shipping_address_snapshot,metadata=excluded.metadata`,
    [fulfillmentId, order.id, status,
      ["ready_to_ship","partially_shipped","completed"].includes(status) ? timestamp : null,
      ["partially_shipped","completed"].includes(status) ? timestamp : null,
      status === "completed" ? timestamp : null,
      JSON.stringify({ publicOrderNumber: order.publicOrderNumber, fixture: true }),
      "DO NOT SHIP - TEST FIXTURE", JSON.stringify(safeShippingAddress), JSON.stringify({ fixture: true }), timestamp]);
    const itemId = sequenceId(ids.fulfillmentItemBase + index);
    await ownedWrite(db, {
      fixtureKey: `workflow.fulfillment-item.${orderKey}`, tableName: "order_fulfillment_items", rowId: itemId,
      naturalKey: { fulfillmentId, orderItemId: order.itemId }, canonical: { quantity }
    }, "select id::text from order_fulfillment_items where id=$1 or (fulfillment_id=$2 and order_item_id=$3)",
    [itemId, fulfillmentId, order.itemId],
    `insert into order_fulfillment_items (id,fulfillment_id,order_item_id,quantity,item_snapshot,metadata)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     on conflict (id) do update set quantity=excluded.quantity,item_snapshot=excluded.item_snapshot,metadata=excluded.metadata`,
    [itemId, fulfillmentId, order.itemId, quantity,
      JSON.stringify({ quantity: order.quantity, fixture: true }), JSON.stringify({ fixture: true })]);
  }

  const shipmentDefinitions = [
    ["ready", fixtureShipments.ready, fixtureFulfillments.ready, "label_pending", 1],
    ["partial-shipment", fixtureShipments.partial, fixtureFulfillments.partial, "in_transit", 1],
    ["delivered", fixtureShipments.delivered, fixtureFulfillments.delivered, "completed", 1]
  ] as const;
  for (const [index, [orderKey, shipmentId, fulfillmentId, status, quantity]] of shipmentDefinitions.entries()) {
    const order = fixtureOrder(orderKey);
    await ownedWrite(db, {
      fixtureKey: `workflow.shipment.${orderKey}`, tableName: "shipments", rowId: shipmentId,
      naturalKey: { orderId: order.id, number: 1 }, canonical: { status, quantity, carrier: "TEST_CARRIER" }
    }, "select id::text from shipments where id=$1 or (order_id=$2 and shipment_number=1)", [shipmentId, order.id],
    `insert into shipments (id,order_id,fulfillment_id,shipment_number,status,carrier,carrier_service,tracking_number,
       tracking_url,currency,ship_to_name_snapshot,ship_to_address_snapshot,shipped_at,delivered_at,completed_at,
       label_metadata,export_metadata,metadata,created_at)
     values ($1,$2,$3,1,$4,'TEST_CARRIER','fixture-only',$5,$6,'usd','DO NOT SHIP - TEST FIXTURE',$7::jsonb,
       $8,$9,$10,'{}'::jsonb,'{}'::jsonb,$11::jsonb,$12)
     on conflict (id) do update set status=excluded.status,carrier='TEST_CARRIER',tracking_number=excluded.tracking_number,
       tracking_url=excluded.tracking_url,shipped_at=excluded.shipped_at,delivered_at=excluded.delivered_at,
       completed_at=excluded.completed_at,metadata=excluded.metadata`,
    [shipmentId, order.id, fulfillmentId, status, `FIXTURE-${index + 1}`,
      `https://example.test/tracking/FIXTURE-${index + 1}`, JSON.stringify(safeShippingAddress),
      status === "label_pending" ? null : order.createdAt,
      status === "completed" ? order.createdAt : null,
      status === "completed" ? order.createdAt : null,
      JSON.stringify({ fixture: true }), order.createdAt]);
    const itemId = sequenceId(ids.shipmentItemBase + index);
    await ownedWrite(db, {
      fixtureKey: `workflow.shipment-item.${orderKey}`, tableName: "shipment_items", rowId: itemId,
      naturalKey: { shipmentId, orderItemId: order.itemId }, canonical: { quantity }
    }, "select id::text from shipment_items where id=$1 or (shipment_id=$2 and order_item_id=$3)",
    [itemId, shipmentId, order.itemId],
    `insert into shipment_items (id,shipment_id,order_item_id,quantity,item_snapshot,metadata)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     on conflict (id) do update set quantity=excluded.quantity,item_snapshot=excluded.item_snapshot,metadata=excluded.metadata`,
    [itemId, shipmentId, order.itemId, quantity, JSON.stringify({ fixture: true }), JSON.stringify({ fixture: true })]);
  }
}

async function seedShippingExportHistory(db: FixtureQueryable) {
  const admin = fixtureIdentities.find((entry) => entry.key === "identity.admin")!;
  const entries = [
    { batchId: fixtureExports.cancelledBatch, itemId: fixtureExports.cancelledItem, order: fixtureOrder("ready"), shipmentId: fixtureShipments.ready, status: "cancelled", expires: fixtureTimes.activeReservationExpiresAt, cancelled: "2026-10-20T12:00:00.000Z", purged: null, snapshot: { name: "DO NOT SHIP - TEST FIXTURE", address: safeShippingAddress } },
    { batchId: fixtureExports.expiredBatch, itemId: fixtureExports.expiredItem, order: fixtureOrder("delivered"), shipmentId: fixtureShipments.delivered, status: "expired", expires: "2026-10-20T12:00:00.000Z", cancelled: null, purged: "2026-10-21T12:00:00.000Z", snapshot: null }
  ] as const;
  for (const [index, entry] of entries.entries()) {
    const createdAt = "2026-10-15T12:00:00.000Z";
    const keyHash = sha256(`fixture-export-${index}`);
    await ownedWrite(db, {
      fixtureKey: `workflow.export.${entry.status}`, tableName: "shipping_export_batches", rowId: entry.batchId,
      naturalKey: { provider: "pirate_ship", idempotencyKeyHash: keyHash }, canonical: entry, immutable: true
    }, "select id::text from shipping_export_batches where id=$1 or (provider='pirate_ship' and idempotency_key_hash=$2)",
    [entry.batchId, keyHash],
    `insert into shipping_export_batches (id,provider,format,mapping_version,status,actor_user_id,actor_auth_subject,
       request_id,idempotency_key_hash,request_fingerprint,row_count,file_sha256,file_size_bytes,expires_at,
       cancelled_at,purged_at,created_at)
     values ($1,'pirate_ship','csv',1,$2,$3,$4,$5,$6,$7,1,$8,128,$9,$10,$11,$12) on conflict (id) do nothing`,
    [entry.batchId, entry.status, admin.userId, admin.authSubject, `fixture-export-${index}`,
      keyHash, sha256(`request-${index}`), sha256(`file-${index}`), entry.expires,
      entry.cancelled, entry.purged, createdAt]);
    await ownedWrite(db, {
      fixtureKey: `workflow.export-item.${entry.status}`, tableName: "shipping_export_batch_items", rowId: entry.itemId,
      naturalKey: { batchId: entry.batchId, orderId: entry.order.id }, canonical: entry.snapshot, immutable: true
    }, "select id::text from shipping_export_batch_items where id=$1 or (batch_id=$2 and order_id=$3)",
    [entry.itemId, entry.batchId, entry.order.id],
    `insert into shipping_export_batch_items (id,batch_id,order_id,shipment_id,row_number,row_snapshot,row_sha256,reconciliation_token_hash,created_at)
     values ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8) on conflict (id) do nothing`,
    [entry.itemId, entry.batchId, entry.order.id, entry.shipmentId,
      entry.snapshot ? JSON.stringify(entry.snapshot) : null, sha256(`row-${index}`),
      sha256(`reconciliation-${index}`), createdAt]);
  }
}

export function operationalReferences(): OperationalFixtureReferences {
  const reference = (key: string) => {
    const order = fixtureOrder(key);
    return {
      capturedAmountCents:
        order.unitAmountCents * order.quantity +
        (order.currency === "usd" ? 895 : 0) -
        order.discountCents,
      id: order.id,
      publicOrderNumber: order.publicOrderNumber
    };
  };
  return {
    adminUserId: fixtureIdentities.find((entry) => entry.key === "identity.admin")!.userId!,
    awaitingAdminOrder: reference("queue"),
    awaitingCustomerOrder: reference("production"),
    cancelledOrder: reference("cancelled"),
    deliveredOrder: { ...reference("delivered"), shipmentId: fixtureShipments.delivered },
    failedRefundOrder: reference("failed-refund"),
    fullRefundOrder: reference("full-refund"),
    manualReviewRefundOrder: reference("ready"),
    partialRefundOrder: reference("partial-refund"),
    resolvedOrder: reference("missing-production")
  };
}

export async function claimOperationalOwnedRow(
  db: FixtureQueryable,
  row: OperationalOwnedRow,
) {
  const ownership: FixtureOwnership = {
    canonical: { operationalFingerprint: row.canonicalFingerprint },
    fixtureKey: row.fixtureKey,
    immutable: row.immutable,
    naturalKey: { operationalNaturalKeyHash: row.naturalKeyHash },
    rowId: row.rowId,
    tableName: row.tableName
  };
  const existing = await db.query<{ id: string }>(
    `select row_id as id from kapchi_fixture.owned_rows
      where fixture_key=$1 or (table_name=$2 and row_id=$3)`,
    [row.fixtureKey, row.tableName, row.rowId],
  );
  if (existing.rows[0] && existing.rows[0].id !== row.rowId) {
    throw new FixtureSafetyError("FIXTURE_OWNERSHIP_COLLISION", row.fixtureKey, row.tableName);
  }
  await recordFixtureOwnership(db, ownership);
}

export async function seedCoreFixtures(
  db: FixtureQueryable,
  input: {
    expectedStripeAccountId?: string;
    fabrics: readonly CoreSeedFabric[];
    listings: readonly CoreSeedListing[];
    includeOperational?: boolean;
  },
) {
  await seedCatalogFixtures(db, input);
  await seedIdentities(db);
  await seedCartsAssetsAndOrders(db);
  await seedFulfillmentAndShipping(db);
  await seedShippingExportHistory(db);
  const operational = input.includeOperational === false
    ? null
    : await seedOperationalFixtures(db, {
        claimOwnedRow: (row) => claimOperationalOwnedRow(db, row),
        references: operationalReferences()
      });
  return {
    analytics: expectedCurrentUsdAnalytics.metrics,
    identities: fixtureIdentities.length,
    operational,
    orders: fixtureOrders.length
  };
}
