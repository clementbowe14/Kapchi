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
  getGuestCartClaimContext,
  getGuestCartContext,
  getGuestCartSessionContext,
  getOrCreateGuestCartContext,
  MAX_GUEST_SESSION_RECORD_BYTES
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
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

  test("recovers a durable cart when Redis has no session for a valid cookie", async () => {
    const sessionId = "expired_session_id_abcdefghijklmnopqrstuvwxyz123456";
    const { calls, redis } = createRedisMock();
    const { calls: databaseCalls, database } = createDatabaseMock([
      {
        rows: [
          {
            created_at: fixedNow,
            expires_at: "2026-06-30T12:00:00.000Z",
            id: existingCartId
          }
        ]
      }
    ]);
    const { cookies, reply } = createReplyMock();
    const request = createRequestMock(redis, database, { session_id: sessionId });

    const context = await getOrCreateGuestCartContext(
      request,
      reply,
    );

    expect(calls.get).toEqual([`guest_session:${sha256(sessionId)}`]);
    expect(calls.setEx.length).toBe(1);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("where guest_token_hash = $1");
    expect(calls.setEx[0]).toMatchObject({
      key: `guest_session:${sha256(sessionId)}`,
      ttl: sevenDaysInSeconds
    });
    expect(context).toEqual({ cartId: existingCartId, sessionId });
    expect(cookies).toHaveLength(0);
    expect(request.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOutcome: "miss",
        cacheRepaired: true,
        cartId: existingCartId,
        event: "cart.guest_session.recovered"
      }),
      "Guest cart session recovered from durable state",
    );
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
    expect(databaseCalls).toHaveLength(3);
    expect(databaseCalls[0].text).toContain("select id");
    expect(databaseCalls[1].text).toContain("where guest_token_hash = $1");
    expect(databaseCalls[2].text).toContain("insert into carts");
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
      expect(databaseCalls).toHaveLength(2);
      expect(databaseCalls[0].text).toContain("where guest_token_hash = $1");
      expect(databaseCalls[1].text).toContain("insert into carts");
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
      expect(databaseCalls).toHaveLength(2);
      expect(databaseCalls[0].text).toContain("where guest_token_hash = $1");
      expect(databaseCalls[1].text).toContain("insert into carts");
    } finally {
      parseSpy.mockRestore();
    }
  });

  test("recovers durable state when the Redis read fails", async () => {
    const sessionId = "redis_error_session_abcdefghijklmnopqrstuvwxyz123456789";
    const redisError = new Error("Redis read failed");
    const { redis } = createRedisMock({}, { getError: redisError });
    const { calls: databaseCalls, database } = createDatabaseMock([
      {
        rows: [
          {
            created_at: fixedNow,
            expires_at: "2026-06-30T12:00:00.000Z",
            id: existingCartId
          }
        ]
      }
    ]);
    const { cookies, reply } = createReplyMock();
    const request = createRequestMock(redis, database, { session_id: sessionId });

    await expect(
      getOrCreateGuestCartContext(request, reply),
    ).resolves.toEqual({ cartId: existingCartId, sessionId });
    expect(databaseCalls).toHaveLength(1);
    expect(cookies).toHaveLength(0);
    expect(request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheError: { errorType: "Error" },
        cacheOperation: "read",
        event: "cart.guest_session.cache_failed"
      }),
      "Guest cart session cache read failed",
    );
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

  test("creates a durable guest cart and sets its cookie when Redis is unavailable", async () => {
    const operationOrder: string[] = [];
    const redisError = new Error("redis://secret-host unavailable");
    const { calls, redis } = createRedisMock(
      {},
      { operationOrder, setExError: redisError },
    );
    const { calls: databaseCalls, database } = createDatabaseMock(
      [{ rows: [] }],
      operationOrder,
    );
    const { cookies, reply } = createReplyMock(operationOrder);
    const request = createRequestMock(redis, database);

    const context = await getOrCreateGuestCartContext(request, reply);

    expect(operationOrder).toEqual([
      "database:query",
      "redis:setEx",
      "cookie:set"
    ]);
    expect(databaseCalls).toHaveLength(1);
    expect(databaseCalls[0].text).toContain("insert into carts");
    expect(databaseCalls[0].text).not.toContain("set status = 'abandoned'");
    expect(calls.setEx).toHaveLength(1);
    expect(context.cartId).toBe(JSON.parse(calls.setEx[0].value).cartId);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe(context.sessionId);
    expect(request.log.warn).toHaveBeenCalledWith(
      {
        event: "cart.guest_session.cache_failed",
        cacheOperation: "create",
        cartId: context.cartId,
        cacheError: { errorType: "Error" }
      },
      "Guest cart session cache write failed",
    );
    expect(JSON.stringify(vi.mocked(request.log.warn).mock.calls)).not.toContain(
      "secret-host",
    );
    expect(JSON.stringify(vi.mocked(request.log.warn).mock.calls)).not.toContain(
      context.sessionId,
    );
    expect(JSON.stringify(vi.mocked(request.log.warn).mock.calls)).not.toContain(
      sha256(context.sessionId),
    );
  });

  test("recovers a guest cart created during a Redis outage and repairs the cache", async () => {
    const unavailableRedis = createRedisMock({}, {
      setExError: new Error("Redis write failed")
    });
    const creationDatabase = createDatabaseMock([{ rows: [] }]);
    const creationReply = createReplyMock();

    const createdContext = await getOrCreateGuestCartContext(
      createRequestMock(unavailableRedis.redis, creationDatabase.database),
      creationReply.reply,
    );

    const { calls: recoveredRedisCalls, redis: recoveredRedis } =
      createRedisMock();
    const { calls: recoveryDatabaseCalls, database: recoveryDatabase } =
      createDatabaseMock([
        {
          rows: [
            {
              created_at: fixedNow,
              expires_at: "2026-06-30T12:00:00.000Z",
              id: createdContext.cartId
            }
          ]
        }
      ]);
    const recoveryReply = createReplyMock();
    const recoveryRequest = createRequestMock(
      recoveredRedis,
      recoveryDatabase,
      { session_id: createdContext.sessionId },
    );

    await expect(
      getOrCreateGuestCartContext(recoveryRequest, recoveryReply.reply),
    ).resolves.toEqual(createdContext);
    expect(recoveredRedisCalls.get).toEqual([
      `guest_session:${sha256(createdContext.sessionId)}`
    ]);
    expect(recoveredRedisCalls.setEx).toHaveLength(1);
    expect(recoveredRedisCalls.setEx[0]).toMatchObject({
      key: `guest_session:${sha256(createdContext.sessionId)}`,
      ttl: sevenDaysInSeconds
    });
    expect(JSON.parse(recoveredRedisCalls.setEx[0].value)).toEqual({
      cartId: createdContext.cartId,
      createdAt: fixedNow
    });
    expect(recoveryDatabaseCalls).toHaveLength(1);
    expect(recoveryDatabaseCalls[0].text).toContain(
      "where guest_token_hash = $1",
    );
    expect(recoveryDatabaseCalls[0].values).toEqual([
      sha256(createdContext.sessionId)
    ]);
    expect(recoveryReply.cookies).toHaveLength(0);
    expect(recoveryRequest.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOutcome: "miss",
        cacheRepaired: true,
        cartId: createdContext.cartId,
        event: "cart.guest_session.recovered"
      }),
      "Guest cart session recovered from durable state",
    );
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

  test("non-creating lookup recovers a Redis miss without rotating the cookie", async () => {
    const sessionId = "lookup_recovery_session_abcdefghijklmnopqrstuvwxyz123456";
    const { calls: redisCalls, redis } = createRedisMock();
    const { calls: databaseCalls, database } = createDatabaseMock([
      {
        rows: [
          {
            created_at: fixedNow,
            expires_at: "2026-06-30T12:00:00.000Z",
            id: existingCartId
          }
        ]
      }
    ]);
    const request = createRequestMock(redis, database, { session_id: sessionId });

    await expect(getGuestCartContext(request)).resolves.toEqual({
      cartId: existingCartId,
      sessionId
    });
    expect(databaseCalls).toHaveLength(1);
    expect(redisCalls.setEx).toHaveLength(1);
    expect(request.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOutcome: "miss", cacheRepaired: true }),
      "Guest cart session recovered from durable state",
    );
  });

  test("keeps durable recovery available when cache repair fails safely", async () => {
    const sessionId = "repair_failure_session_abcdefghijklmnopqrstuvwxyz123456";
    const { redis } = createRedisMock(
      {},
      { setExError: new Error("redis://secret-host unavailable") },
    );
    const { database } = createDatabaseMock([
      {
        rows: [
          {
            created_at: fixedNow,
            expires_at: "2026-06-30T12:00:00.000Z",
            id: existingCartId
          }
        ]
      }
    ]);
    const request = createRequestMock(redis, database, { session_id: sessionId });

    await expect(getGuestCartContext(request)).resolves.toEqual({
      cartId: existingCartId,
      sessionId
    });
    expect(request.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheError: { errorType: "Error" },
        cacheOperation: "repair",
        cartId: existingCartId,
        event: "cart.guest_session.cache_failed"
      }),
      "Guest cart session cache repair failed",
    );
    expect(request.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ cacheRepaired: false }),
      "Guest cart session recovered from durable state",
    );
    expect(JSON.stringify(vi.mocked(request.log.warn).mock.calls)).not.toContain(
      "secret-host",
    );
    expect(JSON.stringify(vi.mocked(request.log.info).mock.calls)).not.toContain(
      sessionId,
    );
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
