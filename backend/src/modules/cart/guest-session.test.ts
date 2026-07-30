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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
  test("reads guest cart items from Redis", async () => {
    const cartId = "cart-items";
    const items = [
      { listingId: "listing-1", quantity: 2 },
      { listingId: "listing-2", quantity: 1 }
    ];
    const { calls, redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify(items)
    });

    const result = await getGuestCartItems(redis, cartId);

    expect(result).toEqual(items);
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
});
