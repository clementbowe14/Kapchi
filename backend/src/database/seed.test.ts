import { describe, expect, it } from "vitest";
import {
  assertSafeLocalSeedTarget,
  localSeedFixtures,
  seedFabrics,
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
});
