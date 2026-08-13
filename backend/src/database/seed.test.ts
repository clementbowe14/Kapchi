import { describe, expect, it, vi } from "vitest";
import {
  assertSafeLocalSeedTarget,
  localSeedFixtures,
  seedFabrics,
  seedListing,
  seedListings
} from "./seed.js";

describe("assertSafeLocalSeedTarget", () => {
  it("allows localhost PostgreSQL URLs outside production", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@localhost:5432/kapchi_local",
        "development",
      ),
    ).not.toThrow();
  });

  it("refuses production mode", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@localhost:5432/kapchi_local",
        "production",
      ),
    ).toThrow("NODE_ENV=production");
  });

  it("refuses non-local database hosts", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@db.example.com:5432/kapchi",
        "development",
      ),
    ).toThrow('Refusing to seed non-local database host "db.example.com"');
  });

  it("requires a PostgreSQL URL", () => {
    expect(() =>
      assertSafeLocalSeedTarget("mysql://localhost/kapchi", "development"),
    ).toThrow("postgres or postgresql");
  });

  it("refuses localhost database names that do not look local", () => {
    expect(() =>
      assertSafeLocalSeedTarget(
        "postgresql://kapchi:kapchi@localhost:5432/kapchi",
        "development",
      ),
    ).toThrow("must include dev, test, or local");
  });
});

describe("local seed fixtures", () => {
  it("exports reusable example listings and fabric inventory for tests", () => {
    expect(seedListings.map((listing) => listing.slug)).toEqual([
      "local-seed-classic-graduation-stole",
      "local-seed-gold-honor-cord"
    ]);
    expect(
      seedListings[0].priceVariants.map((variant) => variant.variantKey),
    ).toEqual([
      "blank",
      "text-short",
      "text-long",
      "text-long-image",
      "text-image-trim"
    ]);
    expect(seedFabrics.map((fabric) => fabric.sku)).toEqual([
      "LOCAL-SEED-NAVY-SATIN",
      "LOCAL-SEED-GOLD-SATIN"
    ]);
    expect(seedFabrics.every((fabric) => fabric.imageUrl.startsWith("/images/"))).toBe(
      true,
    );
  });

  it("uses deterministic fake order and customer-safe contact data", () => {
    expect(localSeedFixtures.order.publicOrderNumber).toBe("LOCAL-SEED-1001");
    expect(localSeedFixtures.contact.email.endsWith("@example.test")).toBe(true);
    expect(localSeedFixtures.asset.url).toContain("example.test");
    expect(localSeedFixtures.seededAtIso).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves synchronized IDs and deactivates obsolete variants last", async () => {
    const statements: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("insert into listings")) {
          return { rows: [{ id: "listing-1" }] };
        }
        if (sql.includes("insert into listing_customization_sets")) {
          return { rows: [{ id: `customization-${statements.length}` }] };
        }
        return { rows: [] };
      })
    };

    await seedListing(db as never, seedListings[0]);

    const listingUpsert = statements.find((sql) => sql.includes("insert into listings"));
    const desiredVariantUpdates = statements
      .map((sql, index) => ({ index, sql }))
      .filter(({ sql }) =>
        sql.includes("update listing_price_variants") &&
        sql.includes("listing_customization_set_id = $2"),
      );
    const obsoleteDeactivationIndex = statements.findIndex((sql) =>
      sql.includes("not (variant_key = any($2::text[]))"),
    );

    expect(listingUpsert).toContain("then listings.stripe_product_id");
    expect(listingUpsert).toContain("then listings.default_stripe_price_id");
    expect(listingUpsert).toContain(
      "default_variant.unit_amount_cents = excluded.base_price_cents",
    );
    expect(listingUpsert).toContain(
      "default_variant.currency = excluded.currency",
    );
    expect(desiredVariantUpdates).toHaveLength(
      seedListings[0].priceVariants.length,
    );
    expect(desiredVariantUpdates[0].sql).toContain("then stripe_product_id");
    expect(desiredVariantUpdates[0].sql).toContain("then stripe_price_id");
    expect(desiredVariantUpdates[0].sql).toContain("unit_amount_cents = $4");
    expect(desiredVariantUpdates[0].sql).toContain("currency = 'usd'");
    expect(obsoleteDeactivationIndex).toBeGreaterThan(
      desiredVariantUpdates.at(-1)!.index,
    );
  });
});
