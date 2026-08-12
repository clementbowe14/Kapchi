import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
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
  getGuestCartClaimContext,
  getGuestCartContext,
  getGuestCartSessionContext,
  getOrCreateGuestCartContext,
  MAX_GUEST_SESSION_RECORD_BYTES,
  readGuestCartItems
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

type DatabaseCall = {
  text: string;
  values: unknown[];
};

type DatabaseResult = {
  rows: Array<Record<string, unknown>>;
};

type RedisMockOptions = {
  getError?: Error;
  operationOrder?: string[];
  setExError?: Error;
};

const sevenDaysInSeconds = 60 * 60 * 24 * 7;
const fixedNow = "2026-06-23T12:00:00.000Z";
const existingCartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
const displayIds = {
  cartItem: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  fabric: "661f833a-41c5-4ec9-8232-e1883f6be7ed",
  imageAsset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  variant: "9a990125-7cf1-4f7d-813a-b418093aade0"
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
    listingPriceVariantId: displayIds.variant,
    customizationSummary: {
      fontOptionId: null,
      line1: "Class of 2026",
      line2: "Kapchi University",
      imageAssetId: displayIds.imageAsset,
      trimOptionId: null
    },
    validationStatus: "valid",
    ...overrides
  };
}

function createProjectionWithExactByteLength(targetBytes: number) {
  const items = Array.from({ length: 50 }, () =>
    createValidDisplayItem({
      customizationSummary: {
        fontOptionId: null,
        line1: "",
        line2: "",
        imageAssetId: null,
        trimOptionId: null
      }
    }),
  );
  let serialized = JSON.stringify(items);
  let remainingBytes = targetBytes - Buffer.byteLength(serialized, "utf8");

  for (const item of items) {
    for (const line of ["line1", "line2"] as const) {
      const addedCharacters = Math.min(512, remainingBytes);
      item.customizationSummary[line] = "x".repeat(addedCharacters);
      remainingBytes -= addedCharacters;

      if (remainingBytes === 0) {
        serialized = JSON.stringify(items);
        return serialized;
      }
    }
  }

  throw new Error(`Unable to build a ${targetBytes}-byte valid projection.`);
}

function createRedisMock(
  values: Record<string, string | null> = {},
  options: RedisMockOptions = {},
) {
  const calls: RedisCalls = {
    get: [],
    setEx: []
  };

  const redis = {
    async get(key: string) {
      calls.get.push(key);
      options.operationOrder?.push("redis:get");

      if (options.getError) {
        throw options.getError;
      }

      return values[key] ?? null;
    },
    async setEx(key: string, ttl: number, value: string) {
      calls.setEx.push({ key, ttl, value });
      options.operationOrder?.push("redis:setEx");

      if (options.setExError) {
        throw options.setExError;
      }

      values[key] = value;
      return "OK";
    }
  } as unknown as RedisClientType;

  return { calls, redis };
}

function createDatabaseMock(
  responses: Array<DatabaseResult | Error> = [],
  operationOrder: string[] = [],
) {
  const calls: DatabaseCall[] = [];
  const database = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      operationOrder.push("database:query");
      const response = responses.shift() ?? { rows: [] };

      if (response instanceof Error) {
        throw response;
      }

      return response;
    }
  } as unknown as Pool;

  return { calls, database };
}

function createReplyMock(operationOrder: string[] = []) {
  const cookies: CookieCall[] = [];
  const reply = {
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
      operationOrder.push("cookie:set");
      return this;
    }
  } as unknown as FastifyReply;

  return { cookies, reply };
}

function createRequestMock(
  redis: RedisClientType,
  database: Pool,
  cookies: Record<string, string | undefined> = {},
) {
  return {
    cookies,
    log: {
      error: vi.fn()
    },
    server: {
      pg: database,
      redis
    }
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(fixedNow));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guest session cart context", () => {
  test("hashes the cookie for Redis and durable ownership checks", async () => {
    const sessionId = "existing_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const session = {
      cartId: existingCartId,
      createdAt: fixedNow
    };
    const hashedKey = `guest_session:${sha256(sessionId)}`;
    const { calls, redis } = createRedisMock({
      [hashedKey]: JSON.stringify(session)
    });
    const { calls: databaseCalls, database } = createDatabaseMock([
      { rows: [{ id: existingCartId }] }
    ]);
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database, { session_id: sessionId }),
      reply,
    );

    expect(Buffer.byteLength(JSON.stringify(session), "utf8")).toBeLessThan(
      MAX_GUEST_SESSION_RECORD_BYTES,
    );
    expect(context).toEqual({
      cartId: session.cartId,
      sessionId
    });
    expect(calls.get).toEqual([hashedKey]);
    expect(calls.get[0]).not.toBe(`guest_session:${sessionId}`);
    expect(calls.get[0].includes(sessionId)).toBe(false);
    expect(calls.setEx.length).toBe(0);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].values).toEqual([
      existingCartId,
      sha256(sessionId)
    ]);
    expect(databaseCalls[0].values).not.toContain(sessionId);
    expect(databaseCalls[0].text).toContain("status = 'active'");
    expect(databaseCalls[0].text).toContain("expires_at > now()");
    expect(cookies.length).toBe(0);
  });

  test("creates PostgreSQL state before Redis and sets the cookie last", async () => {
    const operationOrder: string[] = [];
    const { calls, redis } = createRedisMock({}, { operationOrder });
    const { calls: databaseCalls, database } = createDatabaseMock(
      [{ rows: [] }],
      operationOrder,
    );
    const { cookies, reply } = createReplyMock(operationOrder);

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database),
      reply,
    );

    expect(operationOrder).toEqual([
      "database:query",
      "redis:setEx",
      "cookie:set"
    ]);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("insert into carts");
    expect(databaseCalls[0].text).not.toContain("on conflict");
    expect(databaseCalls[0].values).toEqual([
      context.cartId,
      sha256(context.sessionId),
      "2026-06-30T12:00:00.000Z"
    ]);
    expect(databaseCalls[0].values).not.toContain(context.sessionId);
    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].ttl).toBe(sevenDaysInSeconds);
    expect(calls.setEx[0].key).toMatch(/^guest_session:[a-f0-9]{64}$/);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(JSON.parse(calls.setEx[0].value)).toEqual({
      cartId: context.cartId,
      createdAt: fixedNow
    });
    expect(calls.setEx[0].value).not.toContain(context.sessionId);

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

  test("reuses active durable sessions without renewing any lifetime", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const session = {
      cartId: existingCartId,
      createdAt: fixedNow
    };
    const { calls, redis } = createRedisMock({
      [`guest_session:${sha256(sessionId)}`]: JSON.stringify(session)
    });
    const { calls: databaseCalls, database } = createDatabaseMock([
      { rows: [{ id: existingCartId }] }
    ]);
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database, { session_id: sessionId }),
      reply,
    );

    expect(context).toEqual({
      cartId: session.cartId,
      sessionId
    });
    expect(calls.setEx.length).toBe(0);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("select id");
    expect(databaseCalls[0].text).not.toContain("update carts");
    expect(cookies.length).toBe(0);
  });

  test("creates a new session when the cookie is missing", async () => {
    const { calls, redis } = createRedisMock();
    const { calls: databaseCalls, database } = createDatabaseMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database),
      reply,
    );

    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("insert into carts");
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("creates a new session when Redis has no session for a valid cookie", async () => {
    const sessionId = "expired_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const { calls, redis } = createRedisMock();
    const { calls: databaseCalls, database } = createDatabaseMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database, { session_id: sessionId }),
      reply,
    );

    expect(calls.get).toEqual([`guest_session:${sha256(sessionId)}`]);
    expect(calls.setEx.length).toBe(1);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("insert into carts");
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(context.sessionId).not.toBe(sessionId);
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("creates a new session when the cookie is invalid", async () => {
    const { calls, redis } = createRedisMock();
    const { database } = createDatabaseMock();
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database, {
        session_id: "invalid cookie value!"
      }),
      reply,
    );

    expect(calls.get.length).toBe(0);
    expect(calls.setEx.length).toBe(1);
    expect(calls.setEx[0].key).toBe(`guest_session:${sha256(context.sessionId)}`);
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("rotates Redis-only sessions instead of backfilling their cart", async () => {
    const sessionId = "redis_only_session_abcdefghijklmnopqrstuvwxyz123456789";
    const session = {
      cartId: existingCartId,
      createdAt: fixedNow
    };
    const { calls, redis } = createRedisMock({
      [`guest_session:${sha256(sessionId)}`]: JSON.stringify(session)
    });
    const { calls: databaseCalls, database } = createDatabaseMock([
      { rows: [] },
      { rows: [] }
    ]);
    const { cookies, reply } = createReplyMock();

    const context = await getOrCreateGuestCartContext(
      createRequestMock(redis, database, { session_id: sessionId }),
      reply,
    );

    expect(context.cartId).not.toBe(existingCartId);
    expect(context.sessionId).not.toBe(sessionId);
    expect(databaseCalls).toHaveLength(2);
    expect(databaseCalls[0].text).toContain("select id");
    expect(databaseCalls[1].text).toContain("insert into carts");
    expect(calls.setEx[0].key).toBe(
      `guest_session:${sha256(context.sessionId)}`,
    );
    expect(cookies[0].value).toBe(context.sessionId);
  });

  test("rotates malformed or non-exact Redis session envelopes", async () => {
    const invalidSessionValues = [
      "{not-json",
      "null",
      "42",
      JSON.stringify([existingCartId, fixedNow]),
      JSON.stringify({ createdAt: fixedNow }),
      JSON.stringify({ cartId: existingCartId }),
      JSON.stringify({
        cartId: existingCartId,
        createdAt: fixedNow,
        role: "admin"
      }),
      JSON.stringify({ cartId: "not-a-uuid", createdAt: fixedNow }),
      JSON.stringify({ cartId: existingCartId, createdAt: "not-an-iso-date" }),
      JSON.stringify({ cartId: null, createdAt: fixedNow }),
      JSON.stringify({ cartId: existingCartId, createdAt: null })
    ];

    for (const [index, value] of invalidSessionValues.entries()) {
      const sessionId = `malformed_session_${index}_abcdefghijklmnopqrstuvwxyz123456789`;
      const { redis } = createRedisMock({
        [`guest_session:${sha256(sessionId)}`]: value
      });
      const { calls: databaseCalls, database } = createDatabaseMock();
      const { reply } = createReplyMock();

      const context = await getOrCreateGuestCartContext(
        createRequestMock(redis, database, { session_id: sessionId }),
        reply,
      );

      expect(context.sessionId).not.toBe(sessionId);
      expect(databaseCalls).toHaveLength(1);
      expect(databaseCalls[0].text).toContain("insert into carts");
    }
  });

  test("accepts an exact 1 KiB session and rejects one byte over before parsing", async () => {
    const exactSessionId = "exact_size_session_abcdefghijklmnopqrstuvwxyz123456789";
    const session = { cartId: existingCartId, createdAt: fixedNow };
    const serializedSession = JSON.stringify(session);
    const exactValue = serializedSession.padEnd(
      MAX_GUEST_SESSION_RECORD_BYTES,
      " ",
    );
    const { redis: exactRedis } = createRedisMock({
      [`guest_session:${sha256(exactSessionId)}`]: exactValue
    });
    const { database: exactDatabase } = createDatabaseMock([
      { rows: [{ id: existingCartId }] }
    ]);
    const { reply: exactReply } = createReplyMock();

    await expect(
      getOrCreateGuestCartContext(
        createRequestMock(exactRedis, exactDatabase, {
          session_id: exactSessionId
        }),
        exactReply,
      ),
    ).resolves.toEqual({ cartId: existingCartId, sessionId: exactSessionId });
    expect(Buffer.byteLength(exactValue, "utf8")).toBe(1024);

    const oversizedSessionId =
      "oversized_session_abcdefghijklmnopqrstuvwxyz123456789";
    const oversizedValue = `${exactValue} `;
    const parseSpy = vi.spyOn(JSON, "parse");
    const { redis: oversizedRedis } = createRedisMock({
      [`guest_session:${sha256(oversizedSessionId)}`]: oversizedValue
    });
    const { calls: databaseCalls, database } = createDatabaseMock();
    const { reply } = createReplyMock();

    try {
      const context = await getOrCreateGuestCartContext(
        createRequestMock(oversizedRedis, database, {
          session_id: oversizedSessionId
        }),
        reply,
      );

      expect(Buffer.byteLength(oversizedValue, "utf8")).toBe(1025);
      expect(parseSpy).not.toHaveBeenCalledWith(oversizedValue);
      expect(context.sessionId).not.toBe(oversizedSessionId);
      expect(databaseCalls).toHaveLength(1);
      expect(databaseCalls[0].text).toContain("insert into carts");
    } finally {
      parseSpy.mockRestore();
    }
  });

  test("propagates Redis read failures without database or cookie writes", async () => {
    const sessionId = "redis_error_session_abcdefghijklmnopqrstuvwxyz123456789";
    const redisError = new Error("Redis read failed");
    const { redis } = createRedisMock({}, { getError: redisError });
    const { calls: databaseCalls, database } = createDatabaseMock();
    const { cookies, reply } = createReplyMock();

    await expect(
      getOrCreateGuestCartContext(
        createRequestMock(redis, database, { session_id: sessionId }),
        reply,
      ),
    ).rejects.toBe(redisError);
    expect(databaseCalls).toHaveLength(0);
    expect(cookies).toHaveLength(0);
  });

  test("propagates durable ownership read failures without rotating", async () => {
    const sessionId = "database_error_session_abcdefghijklmnopqrstuvwxyz123456";
    const databaseError = new Error("PostgreSQL read failed");
    const { calls, redis } = createRedisMock({
      [`guest_session:${sha256(sessionId)}`]: JSON.stringify({
        cartId: existingCartId,
        createdAt: fixedNow
      })
    });
    const { database } = createDatabaseMock([databaseError]);
    const { cookies, reply } = createReplyMock();

    await expect(
      getOrCreateGuestCartContext(
        createRequestMock(redis, database, { session_id: sessionId }),
        reply,
      ),
    ).rejects.toBe(databaseError);
    expect(calls.setEx).toHaveLength(0);
    expect(cookies).toHaveLength(0);
  });

  test("does not write Redis or a cookie when durable cart creation fails", async () => {
    const databaseError = new Error("PostgreSQL insert failed");
    const { calls, redis } = createRedisMock();
    const { database } = createDatabaseMock([databaseError]);
    const { cookies, reply } = createReplyMock();

    await expect(
      getOrCreateGuestCartContext(
        createRequestMock(redis, database),
        reply,
      ),
    ).rejects.toBe(databaseError);
    expect(calls.setEx).toHaveLength(0);
    expect(cookies).toHaveLength(0);
  });

  test("abandons the durable cart and rethrows when the Redis write fails", async () => {
    const operationOrder: string[] = [];
    const redisError = new Error("Redis write failed");
    const { calls, redis } = createRedisMock(
      {},
      { operationOrder, setExError: redisError },
    );
    const { calls: databaseCalls, database } = createDatabaseMock(
      [{ rows: [] }, { rows: [] }],
      operationOrder,
    );
    const { cookies, reply } = createReplyMock(operationOrder);

    await expect(
      getOrCreateGuestCartContext(
        createRequestMock(redis, database),
        reply,
      ),
    ).rejects.toBe(redisError);
    expect(operationOrder).toEqual([
      "database:query",
      "redis:setEx",
      "database:query"
    ]);
    expect(databaseCalls[1].text).toContain("set status = 'abandoned'");
    expect(databaseCalls[1].values).toEqual([
      JSON.parse(calls.setEx[0].value).cartId,
      calls.setEx[0].key.replace("guest_session:", "")
    ]);
    expect(cookies).toHaveLength(0);
  });

  test("preserves the Redis error when best-effort abandonment also fails", async () => {
    const redisError = new Error("Redis write failed");
    const abandonmentError = new Error("PostgreSQL abandonment failed");
    const { redis } = createRedisMock({}, { setExError: redisError });
    const { database } = createDatabaseMock([
      { rows: [] },
      abandonmentError
    ]);
    const { cookies, reply } = createReplyMock();
    const request = createRequestMock(redis, database);

    await expect(getOrCreateGuestCartContext(request, reply)).rejects.toBe(
      redisError,
    );
    expect(request.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseError: { errorType: "Error" }
      }),
      "Failed to abandon guest cart after Redis session write failure",
    );
    expect(cookies).toHaveLength(0);
  });

  test("non-creating lookup returns only an active durable context", async () => {
    const sessionId = "lookup_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const session = {
      cartId: existingCartId,
      createdAt: fixedNow
    };
    const sessionKey = `guest_session:${sha256(sessionId)}`;
    const { redis } = createRedisMock({
      [sessionKey]: JSON.stringify(session)
    });
    const { database } = createDatabaseMock([
      { rows: [{ id: existingCartId }] }
    ]);

    await expect(
      getGuestCartContext(
        createRequestMock(redis, database, { session_id: sessionId }),
      ),
    ).resolves.toEqual({ cartId: existingCartId, sessionId });

    const staleRedis = createRedisMock({
      [sessionKey]: JSON.stringify(session)
    }).redis;
    const staleDatabase = createDatabaseMock([{ rows: [] }]).database;

    await expect(
      getGuestCartContext(
        createRequestMock(staleRedis, staleDatabase, {
          session_id: sessionId
        }),
      ),
    ).resolves.toBeNull();
  });

  test("checkout lookup resolves the hashed cookie from PostgreSQL without Redis", async () => {
    const sessionId = "checkout_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const { calls: redisCalls, redis } = createRedisMock();
    const { calls, database } = createDatabaseMock([{ rows: [{ id: cartId }] }]);

    await expect(
      getGuestCartSessionContext(
        createRequestMock(redis, database, { session_id: sessionId }),
      ),
    ).resolves.toEqual({ cartId, sessionId });
    expect(redisCalls.get).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([sha256(sessionId)]);
    expect(calls[0].values).not.toContain(sessionId);
    expect(calls[0].text).toContain("status = 'checkout_started'");
  });

  test("claim lookup accepts only an active unexpired durable guest cart", async () => {
    const sessionId = "claim_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const { calls: redisCalls, redis } = createRedisMock();
    const { calls, database } = createDatabaseMock([{ rows: [{ id: cartId }] }]);

    await expect(
      getGuestCartClaimContext(
        createRequestMock(redis, database, { session_id: sessionId }),
      ),
    ).resolves.toEqual({ cartId, sessionId });

    expect(redisCalls.get).toHaveLength(0);
    expect(calls[0].values).toEqual([sha256(sessionId)]);
    expect(calls[0].text).toContain("status = 'active'");
    expect(calls[0].text).toContain("expires_at > now()");
    expect(calls[0].text).not.toContain("checkout_started");
  });
});

describe("guest cart items", () => {
  test("distinguishes a valid empty projection from a cache miss", async () => {
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const { redis: hitRedis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: "[]"
    });
    const { redis: missRedis } = createRedisMock();

    expect(await readGuestCartItems(hitRedis, cartId)).toEqual({
      hit: true,
      items: []
    });
    expect(await readGuestCartItems(missRedis, cartId)).toEqual({ hit: false });
  });

  test("treats a rejected strict projection as a cache miss", async () => {
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify([
        { ...createValidDisplayItem(), stripeCheckoutSessionId: "cs_secret" }
      ])
    });

    expect(await readGuestCartItems(redis, cartId)).toEqual({ hit: false });
  });

  test("returns fresh typed guest cart display items from Redis", async () => {
    const cartId = "cart-items";
    const items = [
      createValidDisplayItem(),
      createValidDisplayItem({
        cartItemId: "f33d7a50-cd15-418a-96dd-46e8c6466830",
        fabricId: null,
        customizationSummary: {
          fontOptionId: null,
          line1: "",
          line2: "",
          imageAssetId: null,
          trimOptionId: null
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
          fontOptionId: null,
          line1: "Class of 2026",
          line2: "Kapchi University",
          imageAssetId: displayIds.imageAsset,
          trimOptionId: null,
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
          fontOptionId: null,
          line1: "Class of 2026",
          line2: "Kapchi University",
          imageAssetId: "not-a-uuid",
          trimOptionId: null
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

  test("accepts exact text limits and rejects one character over", async () => {
    const cartId = "exact-text-limits-cart";
    const exactLimitItem = createValidDisplayItem({
      listingSlug: "s".repeat(255),
      title: "t".repeat(255),
      customizationSummary: {
        fontOptionId: null,
        line1: "x".repeat(512),
        line2: "y".repeat(512),
        imageAssetId: null,
        trimOptionId: null
      }
    });
    const { redis } = createRedisMock({
      [buildGuestCartItemsKey(cartId)]: JSON.stringify([exactLimitItem])
    });

    await expect(getGuestCartItems(redis, cartId)).resolves.toEqual([
      exactLimitItem
    ]);

    const invalidItems = [
      createValidDisplayItem({ listingSlug: "" }),
      createValidDisplayItem({ listingSlug: "s".repeat(256) }),
      createValidDisplayItem({ title: "" }),
      createValidDisplayItem({ title: "t".repeat(256) }),
      createValidDisplayItem({
        customizationSummary: {
          fontOptionId: null,
          line1: "x".repeat(513),
          line2: "",
          imageAssetId: null,
          trimOptionId: null
        }
      }),
      createValidDisplayItem({
        customizationSummary: {
          fontOptionId: null,
          line1: "",
          line2: "y".repeat(513),
          imageAssetId: null,
          trimOptionId: null
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

  test("accepts exactly 100 items and rejects 101", async () => {
    const exactCartId = "exact-item-count-cart";
    const items = Array.from({ length: 101 }, (_, index) =>
      createValidDisplayItem({
        cartItemId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
      }),
    );
    const { redis: exactRedis } = createRedisMock({
      [buildGuestCartItemsKey(exactCartId)]: JSON.stringify(items.slice(0, 100))
    });
    const overCartId = "over-item-count-cart";
    const { redis: overRedis } = createRedisMock({
      [buildGuestCartItemsKey(overCartId)]: JSON.stringify(items)
    });

    expect(await getGuestCartItems(exactRedis, exactCartId)).toHaveLength(100);
    expect(await getGuestCartItems(overRedis, overCartId)).toEqual([]);
  });

  test("accepts exactly 64 KiB and rejects one UTF-8 byte over", async () => {
    const exactCartId = "exact-byte-limit-cart";
    const exactProjection = createProjectionWithExactByteLength(64 * 1024);
    const overCartId = "over-byte-limit-cart";
    const overProjection = createProjectionWithExactByteLength(64 * 1024 + 1);
    const { redis: exactRedis } = createRedisMock({
      [buildGuestCartItemsKey(exactCartId)]: exactProjection
    });
    const { redis: overRedis } = createRedisMock({
      [buildGuestCartItemsKey(overCartId)]: overProjection
    });

    expect(Buffer.byteLength(exactProjection, "utf8")).toBe(64 * 1024);
    expect(await getGuestCartItems(exactRedis, exactCartId)).toHaveLength(50);
    expect(Buffer.byteLength(overProjection, "utf8")).toBe(64 * 1024 + 1);
    expect(await getGuestCartItems(overRedis, overCartId)).toEqual([]);
  });
});
