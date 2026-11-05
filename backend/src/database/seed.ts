import { Pool, type PoolClient } from "pg";
import { loadBackendEnvironment } from "../config/load-environment.js";
import { seedCoreFixtures, type CoreSeedFabric, type CoreSeedListing } from "./fixtures/core.js";
import {
  acquireFixtureTransactionLock,
  assertInitializedFixtureDatabase,
  parseSafeFixtureTarget,
  safeFixtureFailure
} from "./fixtures/safety.js";

loadBackendEnvironment();

export type SeedListing = CoreSeedListing;
export type SeedFabric = CoreSeedFabric;

export const seedListings: SeedListing[] = [
  {
    basePriceCents: 4500,
    description: "Local seed graduation stole with editable text, image, trim, and fabric options.",
    imageAlt: "Local seed navy graduation stole preview",
    imageUrl: "/images/hero/personalized-woven-stole.webp",
    listingType: "graduation_stole",
    priceVariants: [
      { customizationKind: "blank", stripePriceId: "price_local_seed_stole_blank", unitAmountCents: 4500, variantKey: "blank" },
      { customizationKind: "text_short", stripePriceId: "price_local_seed_stole_text_short", unitAmountCents: 5000, variantKey: "text-short" },
      { customizationKind: "text_long", stripePriceId: "price_local_seed_stole_text_long", unitAmountCents: 5500, variantKey: "text-long" },
      { customizationKind: "text_image", stripePriceId: "price_local_seed_stole_text_image", unitAmountCents: 6000, variantKey: "text-long-image" },
      { customizationKind: "text_image_trim", stripePriceId: "price_local_seed_stole_personalized", unitAmountCents: 6500, variantKey: "text-image-trim" }
    ],
    requiresFabric: true,
    slug: "local-seed-classic-graduation-stole",
    stripeProductId: "prod_local_seed_classic_stole",
    subtitle: "Seed data only",
    title: "Classic Graduation Stole"
  },
  {
    basePriceCents: 1800,
    description: "Local seed honor cord accessory for cart and checkout workflow testing.",
    imageAlt: "Local seed gold honor cord preview",
    imageUrl: "/images/hero/personalized-woven-stole.webp",
    listingType: "accessory",
    priceVariants: [
      { customizationKind: "blank", stripePriceId: "price_local_seed_honor_cord", unitAmountCents: 1800, variantKey: "blank" }
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
    colorHex: "#12335B", colorName: "Navy",
    imageAlt: "Woven blue fabric detail on a graduation stole",
    imageUrl: "/images/hero/woven-stole-detail.webp", material: "Satin",
    name: "Local Seed Navy Satin", quantityOnHand: 40, quantityReserved: 1,
    quantitySold: 3, sku: "LOCAL-SEED-NAVY-SATIN", status: "active"
  },
  {
    colorHex: "#D4AF37", colorName: "Gold",
    imageAlt: "Gold-trimmed woven fabric samples beside a graduation stole",
    imageUrl: "/images/hero/personalized-woven-stole.webp", material: "Satin",
    name: "Local Seed Gold Satin", quantityOnHand: 30, quantityReserved: 0,
    quantitySold: 2, sku: "LOCAL-SEED-GOLD-SATIN", status: "active"
  }
];

export const localSeedFixtures = {
  asset: { id: "85000000-0000-4000-8000-000000004001", objectKey: "fixture-only/artwork/class-of-2026.png", url: "https://example.test/fixture-only/artwork/class-of-2026.png" },
  cart: { id: "85000000-0000-4000-8000-000000003002", itemId: "85000000-0000-4000-8000-000000003102", userId: "fixture_customer_returning" },
  contact: { email: "returning@example.test", name: "Returning Fixture Customer", phone: "+12025550101" },
  order: { id: "85000000-0000-4000-8000-000000001003", itemId: "85000000-0000-4000-8000-000000002003", publicOrderNumber: "LOCAL-SEED-1001" },
  seededAtIso: "2026-10-01T12:00:00.000Z"
} as const;

export function assertSafeLocalSeedTarget(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV ?? "development",
) {
  parseSafeFixtureTarget(databaseUrl, nodeEnv);
}

// A focused test seam. Normal callers should use seedLocalDatabase.
export async function seedListing(db: Pick<PoolClient, "query">, listing: SeedListing) {
  await seedCoreFixtures(db, { fabrics: seedFabrics, includeOperational: false, listings: [listing] });
}

export async function seedLocalDatabase(
  pool: Pool,
  options: { includeOperational?: boolean; token?: string } = {},
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertInitializedFixtureDatabase({
      databaseUrl: process.env.DATABASE_URL,
      db: client,
      nodeEnv: process.env.NODE_ENV,
      token: options.token ?? process.env.KAPCHI_FIXTURE_DATABASE_TOKEN
    });
    await acquireFixtureTransactionLock(client);
    const result = await seedCoreFixtures(client, {
      fabrics: seedFabrics,
      includeOperational: options.includeOperational,
      listings: seedListings
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function runSeedLocal() {
  assertSafeLocalSeedTarget();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 5000),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30000),
    max: 1
  });
  try {
    const result = await seedLocalDatabase(pool);
    console.log(JSON.stringify({ event: "fixture.seed.completed", ...result }));
  } finally {
    await pool.end();
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], "file:").href
  : false;

if (invokedAsScript) {
  runSeedLocal().catch((error: unknown) => {
    console.error(JSON.stringify(safeFixtureFailure(error)));
    process.exitCode = 1;
  });
}
