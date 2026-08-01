import cookie from "@fastify/cookie";
import fastify from "fastify";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import { describe, expect, it } from "vitest";

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

const { default: cartPlugin } = await import("./plugin.js");

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
  const gets: string[] = [];
  const writes: Array<{ key: string; ttl: number; value: string }> = [];
  const values: Record<string, string> = {};
  const redis = {
    async get(key: string) {
      gets.push(key);
      return values[key] ?? null;
    },
    async setEx(key: string, ttl: number, value: string) {
      writes.push({ key, ttl, value });
      values[key] = value;
      return "OK";
    }
  } as unknown as RedisClientType;

  return { gets, redis, writes };
}

describe("cartPlugin", () => {
  it("creates a durable guest cart before returning its empty projection", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
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

  it("preserves the authenticated empty-cart response without guest storage", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      request.auth = {
        claims: {},
        permissions: [],
        roles: [],
        sessionId: "authenticated-session",
        token: "test-token",
        userId: "user_123"
      };
    });
    await app.register(cookie);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(queries).toHaveLength(0);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it("does not create a cart when patching without a guest session", async () => {
    const { database, queries } = createDatabaseMock();
    const { redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
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
