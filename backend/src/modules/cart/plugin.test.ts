import { createHash } from "node:crypto";
import cookie from "@fastify/cookie";
import fastify from "fastify";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyClerkToken: vi.fn()
}));

vi.mock("../auth/jwt.js", () => ({
  verifyClerkToken: mocks.verifyClerkToken
}));

const envDefaults: Record<string, string> = {
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_JWT_ISSUER: "https://clerk.test",
  CLERK_PUBLISHABLE_KEY: "test-publishable-key",
  CLERK_SECRET_KEY: "test-secret-key",
  CLERK_WEBHOOK_SECRET: "test-webhook-secret",
  DATABASE_MAX_APP_INSTANCES: "3",
  DATABASE_MAX_CONNECTIONS: "20",
  DATABASE_POOL_MAX: "5",
  DATABASE_RESERVED_CONNECTIONS: "5",
  DATABASE_SSL_MODE: "disable",
  DATABASE_STATEMENT_TIMEOUT_MS: "15000",
  DATABASE_URL: "postgres://user:pass@localhost:5432/kapchi_test",
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const [{ authPlugin }, { default: cartPlugin }] = await Promise.all([
  import("../auth/index.js"),
  import("./plugin.js")
]);

const ids = {
  cart: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  cartItem: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};
const guestSessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
const guestSessionKey = `guest_session:${createHash("sha256")
  .update(guestSessionId)
  .digest("hex")}`;
const expiresAt = "2027-08-01T12:00:00.000Z";

function cartItemPayload() {
  return {
    fabricId: null,
    imageAssetId: null,
    line1: "Class of 2027",
    line2: "Kapchi University",
    listingCustomizationSetId: ids.customizationSet,
    listingId: ids.listing,
    listingPriceVariantId: ids.variant,
    quantity: 1
  };
}

function createDatabaseMock() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let cartId: string | null = null;
  let expiresAt: string | null = null;
  const database = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });

      if (text.includes("insert into carts")) {
        cartId = String(values[0]);
        expiresAt = String(values[2]);
        return { rows: [] };
      }

      if (text.includes("select id, currency, subtotal_cents, expires_at")) {
        return {
          rows: cartId
            ? [
                {
                  currency: "usd",
                  expires_at: expiresAt,
                  id: cartId,
                  subtotal_cents: 0
                }
              ]
            : []
        };
      }

      return { rows: [] };
    }
  } as unknown as Pool;

  return { database, queries };
}

function createRedisMock() {
  const deletes: string[] = [];
  const gets: string[] = [];
  const writes: Array<{ key: string; ttl: number; value: string }> = [];
  const values: Record<string, string> = {};
  const redis = {
    async get(key: string) {
      gets.push(key);
      return values[key] ?? null;
    },
    async del(key: string) {
      deletes.push(key);
      delete values[key];
      return 1;
    },
    async setEx(key: string, ttl: number, value: string) {
      writes.push({ key, ttl, value });
      values[key] = value;
      return "OK";
    }
  } as unknown as RedisClientType;

  return {
    deletes,
    gets,
    redis,
    seed(key: string, value: string) {
      values[key] = value;
    },
    writes
  };
}

function createMutationDatabaseMock(deleting = false) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });

    if (["begin", "commit", "rollback"].includes(text)) {
      return { rows: [] };
    }
    if (
      text.includes("from carts") &&
      text.includes("guest_token_hash") &&
      !text.includes("currency")
    ) {
      return { rows: [{ id: ids.cart }] };
    }
    if (text.includes("from carts") && text.includes("for update")) {
      return {
        rows: [
          {
            id: ids.cart,
            currency: "usd",
            expires_at: expiresAt,
            subtotal_cents: 8500
          }
        ]
      };
    }
    if (text.includes("from cart_items") && text.includes("for update")) {
      return {
        rows: [
          {
            id: ids.cartItem,
            fabric_id: null,
            quantity: 1,
            customization_asset_id: null
          }
        ]
      };
    }
    if (text.includes("from fabric_reservations")) {
      return { rows: [] };
    }
    if (text.includes("from listings l")) {
      return {
        rows: [
          {
            currency: "usd",
            customization_enabled: true,
            listing_status: "active",
            max_chars: 120,
            min_chars: 0,
            price_variant_active: true,
            requires_fabric: false,
            requires_image: false,
            requires_text: true,
            unit_amount_cents: 8500
          }
        ]
      };
    }
    if (text.includes("sum(ci.quantity::bigint")) {
      return { rows: [{ subtotal_cents: deleting ? "0" : "8500" }] };
    }
    if (text.includes("update carts")) {
      return { rows: [{ subtotal_cents: deleting ? 0 : 8500 }] };
    }
    if (text.includes("from cart_items ci") && text.includes("join listings")) {
      return {
        rows: deleting
          ? []
          : [
              {
                cart_item_id: ids.cartItem,
                listing_id: ids.listing,
                listing_slug: "graduation-stole",
                title: "Graduation Stole",
                quantity: 1,
                unit_amount_cents: 8500,
                currency: "usd",
                fabric_id: null,
                customization_set_id: ids.customizationSet,
                customization_payload: cartItemPayload(),
                customization_asset_id: null,
                validation_status: "valid"
              }
            ]
      };
    }

    return { rows: [] };
  });
  const client = { query, release };
  const database = {
    connect: vi.fn(async () => client),
    query
  } as unknown as Pool;

  return { database, queries, release };
}

describe("cartPlugin", () => {
  beforeEach(() => {
    mocks.verifyClerkToken.mockReset();
  });

  it("creates a durable guest cart before returning its empty projection", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({ method: "GET", url: "/" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.cartId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.items).toEqual([]);
    expect(queries).toHaveLength(3);
    expect(queries[0].text).toContain("insert into carts");
    expect(queries[0].values[0]).toBe(body.cartId);
    expect(writes).toHaveLength(2);
    expect(writes[0].key).toMatch(/^guest_session:[a-f0-9]{64}$/);
    expect(JSON.parse(writes[0].value).cartId).toBe(body.cartId);
    expect(writes[1]).toMatchObject({
      key: `guest_cart:${body.cartId}:items`,
      value: "[]"
    });
    expect(gets).toEqual([`guest_cart:${body.cartId}:items`]);
    expect(response.headers["set-cookie"]).toContain("session_id=");
    expect(response.headers["set-cookie"]).toContain("Max-Age=604800");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");

    await app.close();
  });

  it("uses the production auth middleware for authenticated cart reads", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "authenticated-session",
      token: "test-token",
      userId: "user_123"
    });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(queries).toHaveLength(0);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(mocks.verifyClerkToken).toHaveBeenCalledWith("verified-token");

    await app.close();
  });

  it.each([
    ["POST", "/items", cartItemPayload()],
    ["PATCH", `/items/${ids.cartItem}`, cartItemPayload()],
    ["DELETE", `/items/${ids.cartItem}`, undefined]
  ] as const)(
    "rejects authenticated %s mutations before guest session or Redis access",
    async (method, url, payload) => {
      const { database, queries } = createDatabaseMock();
      const { deletes, gets, redis, writes } = createRedisMock();
      const app = fastify({ logger: false });
      mocks.verifyClerkToken.mockResolvedValue({
        claims: {},
        permissions: [],
        roles: [],
        sessionId: "authenticated-session",
        token: "test-token",
        userId: "user_123"
      });
      await app.register(cookie);
      await app.register(authPlugin);
      app.decorate("pg", database);
      app.decorate("redis", redis);
      await app.register(cartPlugin);

      const response = await app.inject({
        headers: { authorization: "Bearer verified-token" },
        method,
        payload,
        url
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: "AUTHENTICATED_CART_MUTATION_UNAVAILABLE",
        statusCode: 403
      });
      expect(queries).toHaveLength(0);
      expect(gets).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(deletes).toHaveLength(0);
      expect(response.headers["set-cookie"]).toBeUndefined();

      await app.close();
    },
  );

  it.each([
    ["PATCH", false],
    ["DELETE", true]
  ] as const)("completes a guest %s mutation from durable session ownership", async (
    method,
    deleting,
  ) => {
    const { database, queries, release } = createMutationDatabaseMock(deleting);
    const { redis, seed, writes } = createRedisMock();
    seed(
      guestSessionKey,
      JSON.stringify({
        cartId: ids.cart,
        createdAt: "2026-08-01T12:00:00.000Z"
      }),
    );
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({
      cookies: { session_id: guestSessionId },
      method,
      payload: deleting ? undefined : cartItemPayload(),
      url: `/items/${ids.cartItem}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cartId: ids.cart,
      items: deleting ? [] : [expect.objectContaining({ cartItemId: ids.cartItem })],
      subtotalCents: deleting ? 0 : 8500
    });
    expect(queries.at(-1)?.text).toBe("commit");
    expect(writes.at(-1)?.key).toBe(`guest_cart:${ids.cart}:items`);
    expect(release).toHaveBeenCalledOnce();

    await app.close();
  });

  it("does not create a cart when patching without a guest session", async () => {
    const { database, queries } = createDatabaseMock();
    const { redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({
      method: "PATCH",
      url: "/items/0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
      payload: {
        fabricId: null,
        imageAssetId: null,
        line1: "Class of 2027",
        line2: "Kapchi University",
        listingCustomizationSetId: "fba94989-b950-4087-bac1-8c1ad4970655",
        listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
        listingPriceVariantId: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
        quantity: 1
      }
    });

    expect(response.statusCode).toBe(404);
    expect(queries).toHaveLength(0);
    expect(writes).toHaveLength(0);

    await app.close();
  });

  it("rejects client-provided pricing before creating a cart", async () => {
    const { database, queries } = createDatabaseMock();
    const { redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({
      method: "POST",
      url: "/items",
      payload: {
        fabricId: null,
        imageAssetId: null,
        line1: "",
        line2: "",
        listingCustomizationSetId: "fba94989-b950-4087-bac1-8c1ad4970655",
        listingId: "396256fa-68f9-4882-934a-5cedffbd8204",
        listingPriceVariantId: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
        quantity: 1,
        unitAmountCents: 1
      }
    });

    expect(response.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
    expect(writes).toHaveLength(0);

    await app.close();
  });
});
