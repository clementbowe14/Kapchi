import { describe, expect, it, vi } from "vitest";
import {
  expectedCurrentUsdAnalytics,
  fixtureIdentities,
  fixtureOrders,
  fixtureTimes
} from "./fixtures/admin-workflows.js";
import {
  assertNoUnownedCollision,
  assertNoUnownedFixtureDependents
} from "./fixtures/ownership.js";
import {
  FixtureSafetyError,
  assertInitializedFixtureDatabase,
  initializeFixtureDatabase,
  parseSafeFixtureTarget,
  safeFixtureFailure
} from "./fixtures/safety.js";
import {
  assertSafeLocalSeedTarget,
  localSeedFixtures,
  seedFabrics,
  seedListings
} from "./seed.js";

const databaseUrl = "postgresql://kapchi:kapchi@localhost:5432/kapchi_local";

describe("fixture target safety", () => {
  it("accepts an explicitly local development database", () => {
    expect(parseSafeFixtureTarget(databaseUrl, "development").databaseName).toBe(
      "kapchi_local",
    );
    expect(() => assertSafeLocalSeedTarget(databaseUrl, "test")).not.toThrow();
  });

  it.each([
    ["postgresql://kapchi@db.example.test/kapchi_local", "development", "FIXTURE_DATABASE_REMOTE"],
    ["postgresql://kapchi@localhost/kapchi", "development", "FIXTURE_DATABASE_NAME_UNSAFE"],
    [databaseUrl, "production", "FIXTURE_NODE_ENV_UNSAFE"],
    ["mysql://localhost/kapchi_local", "test", "FIXTURE_DATABASE_URL_INVALID"]
  ])("rejects unsafe targets", (url, environment, code) => {
    expect(() => parseSafeFixtureTarget(url, environment)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("initializes a marker exactly once and returns the token only to the caller", async () => {
    const statements: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "kapchi_local", database_oid: "42" }] };
        }
        if (sql.includes("to_regnamespace")) return { rows: [{ exists: false }] };
        return { rows: [] };
      })
    };

    const result = await initializeFixtureDatabase({
      confirmDatabase: "kapchi_local",
      databaseUrl,
      db: db as never,
      nodeEnv: "test",
      token: "fixture-token"
    });

    expect(result).toMatchObject({ databaseName: "kapchi_local", token: "fixture-token" });
    expect(statements.some((sql) => sql.includes("create schema kapchi_fixture"))).toBe(true);
    expect(JSON.stringify(statements)).not.toContain("fixture-token");
  });

  it("requires the database-bound token before seeding or verification", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("current_database()")) {
          return { rows: [{ database_name: "kapchi_local", database_oid: "42" }] };
        }
        return { rows: [] };
      })
    };
    await expect(assertInitializedFixtureDatabase({
      databaseUrl,
      db: db as never,
      nodeEnv: "test"
    })).rejects.toMatchObject({ code: "FIXTURE_DATABASE_TOKEN_MISSING" });
  });

  it("redacts unexpected provider and database errors", () => {
    const output = safeFixtureFailure(new Error("postgres://user:secret@prod/private"));
    expect(output).toMatchObject({ errorCode: "FIXTURE_UNEXPECTED_FAILURE" });
    expect(JSON.stringify(output)).not.toContain("secret");
  });
});

describe("fixture ownership", () => {
  it("rejects an unowned natural-key collision", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("kapchi_fixture.owned_rows")) return { rows: [] };
        return { rows: [{ id: "unowned-row" }] };
      })
    };

    await expect(assertNoUnownedCollision(db as never, {
      canonical: { title: "Fixture" },
      fixtureKey: "catalog.listing.fixture",
      naturalKey: { slug: "fixture" },
      rowId: "fixture-row",
      tableName: "listings"
    }, "select id from listings where slug=$1", ["fixture"]))
      .rejects.toBeInstanceOf(FixtureSafetyError);
  });

  it("rejects unowned history attached to the fixture graph", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ count: 1 }] }))
    };

    await expect(assertNoUnownedFixtureDependents(db as never)).rejects.toMatchObject({
      code: "FIXTURE_GRAPH_DIRTY",
      tableAlias: "customer_contacts"
    });
  });
});

describe("admin workflow fixture catalog", () => {
  it("keeps deterministic IDs, natural keys, and synthetic contacts unique", () => {
    expect(new Set(fixtureOrders.map((order) => order.id)).size).toBe(fixtureOrders.length);
    expect(new Set(fixtureOrders.map((order) => order.publicOrderNumber)).size).toBe(fixtureOrders.length);
    expect(fixtureIdentities.filter((identity) => identity.email).every(
      (identity) => identity.email!.endsWith("@example.test"),
    )).toBe(true);
    expect(fixtureIdentities.filter((identity) => identity.phone).every(
      (identity) => /^\+120255501\d{2}$/.test(identity.phone!),
    )).toBe(true);
    expect(fixtureTimes.activeReservationExpiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("uses independently reviewed analytics constants", () => {
    expect(expectedCurrentUsdAnalytics.metrics).toEqual({
      averageOrderValueMinor: 4320,
      discountMinor: 500,
      grossSalesMinor: 43700,
      netSalesMinor: null,
      paidOrderCount: 10,
      successfulRefundsMinor: null,
      unitsSold: 11
    });
  });

  it("preserves the established catalog exports used by checkout tests", () => {
    expect(seedListings.map((listing) => listing.slug)).toEqual([
      "local-seed-classic-graduation-stole",
      "local-seed-gold-honor-cord"
    ]);
    expect(seedFabrics.map((fabric) => fabric.sku)).toEqual([
      "LOCAL-SEED-NAVY-SATIN",
      "LOCAL-SEED-GOLD-SATIN"
    ]);
    expect(localSeedFixtures.order.publicOrderNumber).toBe("LOCAL-SEED-1001");
  });
});
