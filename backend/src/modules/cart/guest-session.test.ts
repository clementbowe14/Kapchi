import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RedisClientType } from "redis";

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
  SHIPPO_API_KEY: "test-shippo-key",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const {
  buildGuestSessionCookieOptions,
  buildGuestCartItemsKey,
  getGuestCartItems,
  getOrCreateGuestCartContext
} = await import("./guest-session.js");

type CookieCall = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

type RedisCalls = {
  get: string[];
  setEx: Array<{ key: string; ttl: number; value: string }>;
};

const sevenDaysInSeconds = 60 * 60 * 24 * 7;
const displayIds = {
  cartItem: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  fabric: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
  imageAsset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204"
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function createValidDisplayItem(overrides: Record<string, unknown> = {}) {
  return {
    cartItemId: displayIds.cartItem,
    listingId: displayIds.listing,
    listingSlug: "graduation-stole",
    title: "Graduation Stole",
    quantity: 1,
    unitAmountCents: 8500,
    currency: "usd",
    fabricId: displayIds.fabric,
    customizationSetId: displayIds.customizationSet,
    customizationSummary: {
      line1: "Class of 2026",
      line2: "Kapchi University",
      imageAssetId: displayIds.imageAsset
    },
    validationStatus: "valid",
    ...overrides
  };
}

function createRedisMock(values: Record<string, string | null> = {}) {
  const calls: RedisCalls = {
    get: [],
    setEx: []
  };

  const redis = {
    async get(key: string) {
      calls.get.push(key);
      return values[key] ?? null;
    },
    async setEx(key: string, ttl: number, value: string) {
      calls.setEx.push({ key, ttl, value });
      values[key] = value;
      return "OK";
    }
  } as unknown as RedisClientType;

  return { calls, redis };
}

function createReplyMock() {
  const cookies: CookieCall[] = [];
  const reply = {
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
      return this;
    }
  } as unknown as FastifyReply;

  return { cookies, reply };
}

function createRequestMock(
  redis: RedisClientType,
  cookies: Record<string, string | undefined> = {},
) {
  return {
    cookies,
    server: {
      redis
    }
  } as unknown as FastifyRequest;
}

describe("guest session cart context", () => {
  test("hashes the session_id cookie into the Redis key", async () => {
    const sessionId = "existing_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const session = {
      cartId: "cart-existing",
      createdAt: "2026-06-23T12:00:00.000Z"
    };
    const hashedKey = `guest_session:${sha256(sessionId)}`;
    const { calls, redis } = createRedisMock({
      [hashedKey]: JSON.stringify(session)
    });
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, { session_id: sessionId }),
      reply,
    );

    expect(context).toEqual({
      cartId: session.cartId,
      sessionId
    });
    expect(calls.get).toEqual([hashedKey]);
    expect(calls.get[0]).not.toBe(`guest_session:${sessionId}`);
    expect(calls.get[0].includes(sessionId)).toBe(false);
    expect(calls.setEx.length).toBe(0);
    expect(cookies.length).toBe(0);
  });

  test("sets a seven-day httpOnly lax root cookie for new non-production sessions", async () => {
    const { calls, redis } = createRedisMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis),
      reply,
    );

    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].ttl).toBe(sevenDaysInSeconds);
    expect(calls.setEx[0].key).toMatch(/^guest_session:[a-f0-9]{64}$/);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);

    expect(cookies.length).toBe(1);
    expect(cookies[0].name).toBe("session_id");
    expect(cookies[0].value).toBe(context.sessionId);
    expect(cookies[0].options).toEqual({
      httpOnly: true,
      maxAge: sevenDaysInSeconds,
      path: "/",
      sameSite: "lax",
      secure: false
    });
  });

  test("sets secure cookies for new production sessions", async () => {
    expect(buildGuestSessionCookieOptions("production").secure).toBe(true);
  });

  test("reuses valid existing sessions without refreshing the cookie", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const session = {
      cartId: "cart-reused",
      createdAt: "2026-06-23T12:00:00.000Z"
    };
    const { calls, redis } = createRedisMock({
      [`guest_session:${sha256(sessionId)}`]: JSON.stringify(session)
    });
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, { session_id: sessionId }),
      reply,
    );

    expect(context).toEqual({
      cartId: session.cartId,
      sessionId
    });
    expect(calls.setEx.length).toBe(0);
    expect(cookies.length).toBe(0);
  });

  test("creates a new session when the cookie is missing", async () => {
    const { calls, redis } = createRedisMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis),
      reply,
    );

    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("creates a new session when Redis has no session for a valid cookie", async () => {
    const sessionId = "expired_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const { calls, redis } = createRedisMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, { session_id: sessionId }),
      reply,
    );

    expect(calls.get).toEqual([`guest_session:${sha256(sessionId)}`]);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(context.sessionId).not.toBe(sessionId);
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("creates a new session when the cookie is invalid", async () => {
    const { calls, redis } = createRedisMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, { session_id: "invalid cookie value!" }),
      reply,
    );

    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(cookies[0].value).toBe(context.sessionId);
  });
});

describe("guest cart items", () => {
  test("returns fresh typed guest cart display items from Redis", async () => {
    const cartId = "cart-items";
    const items = [
      createValidDisplayItem(),
      createValidDisplayItem({
        cartItemId: "f33d7a50-cd15-418a-96dd-46e8c6466830",
        fabricId: null,
        customizationSummary: {
          line1: "",
          line2: "",
          imageAssetId: null
        },
        quantity: 999,
        unitAmountCents: 2_147_483_647,
        validationStatus: "needs_reprice"
      })
    ];
    const { calls, redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify(items)
    });

    const result = await getGuestCartItems(redis, cartId);

    expect(result).toEqual(items);
    expect(result).not.toBe(items);
    expect(result[0]).not.toBe(items[0]);
    expect(result[0].customizationSummary).not.toBe(
      items[0].customizationSummary,
    );
    expect(calls.get).toEqual([buildGuestCartItemsKey(cartId)]);
  });

  test("returns an empty array for missing guest cart items", async () => {
    const { redis } = createRedisMock();

    const result = await getGuestCartItems(redis, "missing-cart");

    expect(result).toEqual([]);
  });

  test("returns an empty array for non-array guest cart values", async () => {
    const cartId = "invalid-cart";
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify({ listingId: "listing-1" })
    });

    const result = await getGuestCartItems(redis, cartId);

    expect(result).toEqual([]);
  });

  test("returns an empty array for malformed guest cart values", async () => {
    const cartId = "malformed-cart";
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: "{not-json"
    });

    const result = await getGuestCartItems(redis, cartId);

    expect(result).toEqual([]);
  });

  test("rejects the entire projection when an item is missing a required field", async () => {
    const cartId = "missing-field-cart";
    const { title: _title, ...incompleteItem } = createValidDisplayItem();
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify([
        createValidDisplayItem(),
        incompleteItem
      ])
    });

    const result = await getGuestCartItems(redis, cartId);

    expect(result).toEqual([]);
  });

  test("rejects unknown and sensitive fields instead of stripping them", async () => {
    const sensitiveItems = [
      createValidDisplayItem({ stripePaymentIntentId: "pi_secret" }),
      createValidDisplayItem({ sessionToken: "raw-session-token" }),
      createValidDisplayItem({ privateUrl: "https://private.test/asset" }),
      createValidDisplayItem({ internalNotes: "do not expose" }),
      createValidDisplayItem({
        customizationSummary: {
          line1: "Class of 2026",
          line2: "Kapchi University",
          imageAssetId: displayIds.imageAsset,
          privateUrl: "https://private.test/asset"
        }
      })
    ];

    for (const [index, item] of sensitiveItems.entries()) {
      const cartId = `sensitive-cart-${index}`;
      const { redis } = createRedisMock({
        [buildGuestCartItemsKey(cartId)]: JSON.stringify([item])
      });

      expect(await getGuestCartItems(redis, cartId)).toEqual([]);
    }
  });

  test("rejects invalid identifiers, numbers, currency, and status", async () => {
    const invalidItems = [
      createValidDisplayItem({ cartItemId: "not-a-uuid" }),
      createValidDisplayItem({ listingId: "not-a-uuid" }),
      createValidDisplayItem({ fabricId: "not-a-uuid" }),
      createValidDisplayItem({ customizationSetId: "not-a-uuid" }),
      createValidDisplayItem({ quantity: 0 }),
      createValidDisplayItem({ quantity: 1000 }),
      createValidDisplayItem({ quantity: 1.5 }),
      createValidDisplayItem({ unitAmountCents: -1 }),
      createValidDisplayItem({ unitAmountCents: 2_147_483_648 }),
      createValidDisplayItem({ unitAmountCents: 1.5 }),
      createValidDisplayItem({ currency: "USD" }),
      createValidDisplayItem({ currency: "us" }),
      createValidDisplayItem({ validationStatus: "pending" }),
      createValidDisplayItem({
        customizationSummary: {
          line1: "Class of 2026",
          line2: "Kapchi University",
          imageAssetId: "not-a-uuid"
        }
      })
    ];

    for (const [index, item] of invalidItems.entries()) {
      const cartId = `invalid-item-cart-${index}`;
      const { redis } = createRedisMock({
        [buildGuestCartItemsKey(cartId)]: JSON.stringify([item])
      });

      expect(await getGuestCartItems(redis, cartId)).toEqual([]);
    }
  });

  test("rejects display text beyond its field limits", async () => {
    const invalidItems = [
      createValidDisplayItem({ listingSlug: "" }),
      createValidDisplayItem({ listingSlug: "s".repeat(256) }),
      createValidDisplayItem({ title: "" }),
      createValidDisplayItem({ title: "t".repeat(256) }),
      createValidDisplayItem({
        customizationSummary: {
          line1: "x".repeat(513),
          line2: "",
          imageAssetId: null
        }
      })
    ];

    for (const [index, item] of invalidItems.entries()) {
      const cartId = `invalid-text-cart-${index}`;
      const { redis } = createRedisMock({
        [buildGuestCartItemsKey(cartId)]: JSON.stringify([item])
      });

      expect(await getGuestCartItems(redis, cartId)).toEqual([]);
    }
  });

  test("rejects projections containing more than 100 items", async () => {
    const cartId = "too-many-items-cart";
    const items = Array.from({ length: 101 }, (_, index) =>
      createValidDisplayItem({
        cartItemId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
      }),
    );
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify(items)
    });

    expect(await getGuestCartItems(redis, cartId)).toEqual([]);
  });

  test("measures the 64 KiB projection limit using UTF-8 bytes", async () => {
    const cartId = "oversized-cart";
    const items = Array.from({ length: 40 }, (_, index) =>
      createValidDisplayItem({
        cartItemId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        customizationSummary: {
          line1: "é".repeat(500),
          line2: "é".repeat(500),
          imageAssetId: null
        }
      }),
    );
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify(items)
    });

    expect(await getGuestCartItems(redis, cartId)).toEqual([]);
  });
});
