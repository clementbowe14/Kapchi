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

const [
  { authPlugin },
  { CartIdempotencyConflictError, InvalidProductionPriorityError },
  cartPluginModule,
] =
  await Promise.all([
    import("../auth/index.js"),
    import("./errors.js"),
    import("./plugin.js")
  ]);
const cartPlugin = cartPluginModule.default;
const { createCartPlugin } = cartPluginModule;

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
    fontOptionId: null,
    imageAssetId: null,
    line1: "Class of 2027",
    line2: "Kapchi University",
    listingCustomizationSetId: ids.customizationSet,
    listingId: ids.listing,
    listingPriceVariantId: ids.variant,
    priorityCode: "standard",
    quantity: 1,
    trimOptionId: null
  };
}

function createDatabaseMock() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let cartId: string | null = null;
  let expiresAt: string | null = null;
  const release = vi.fn();
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });

    if (
      text === "begin" ||
      text === "commit" ||
      text === "rollback" ||
      text.includes("begin isolation level")
    ) {
      return { rows: [] };
    }

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
                revision: 0,
                subtotal_cents: 0
              }
            ]
          : []
      };
    }

    if (text.includes("from cart_items ci") && text.includes("join listings")) {
      return { rows: [] };
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
            revision: 3,
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
            listing_customization_set_id: ids.customizationSet,
            listing_id: ids.listing,
            production_estimate_snapshot: {
              maximumBusinessDays: 7,
              minimumBusinessDays: 5,
              priorityCode: "standard",
              priorityLabel: "Standard",
              quotedAt: "2026-10-01T16:00:00.000Z",
              ruleId: "00000000-0000-4000-8000-000000000093",
              ruleRevision: 1,
              schemaVersion: 1,
            },
            production_priority_code: "standard",
            quantity: 1,
            customization_asset_id: null
          }
        ]
      };
    }
    if (text.includes("from fabric_reservations")) {
      return { rows: [] };
    }
    if (text.includes("from listing_production_estimate_rules")) {
      return {
        rows: [{
          id: "00000000-0000-4000-8000-000000000093",
          label: "Standard",
          maximum_business_days: 7,
          minimum_business_days: 5,
          priority_code: "standard",
          revision: 1,
        }],
      };
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
      return {
        rows: [{ revision: 4, subtotal_cents: deleting ? 0 : 8500 }]
      };
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
                listing_price_variant_id: ids.variant,
                production_priority_code: "standard",
                production_estimate_snapshot: {
                  maximumBusinessDays: 7,
                  minimumBusinessDays: 5,
                  priorityCode: "standard",
                  priorityLabel: "Standard",
                  quotedAt: "2026-10-01T16:00:00.000Z",
                  ruleId: "00000000-0000-4000-8000-000000000093",
                  ruleRevision: 1,
                  schemaVersion: 1,
                },
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

function createClaimDatabaseMock() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });

    if (["begin", "commit", "rollback"].includes(text)) {
      return { rows: [] };
    }
    if (text.includes("insert into users")) {
      return {
        rows: [
          {
            disabled_at: null,
            id: "39bbb0aa-8557-4626-a228-3ed7580bf6ea"
          }
        ]
      };
    }
    if (text.includes("select id from users")) {
      return { rows: [{ id: "39bbb0aa-8557-4626-a228-3ed7580bf6ea" }] };
    }
    if (text.includes("insert into customers")) {
      return { rows: [{ id: "1e1430a4-ab5e-4425-a2f6-3c6718ec23ef" }] };
    }
    if (text.includes("from customer_contacts")) {
      return { rows: [] };
    }
    if (text.includes("authenticated_user_id = $1 or user_id = $2")) {
      return {
        rows: [
          {
            authenticated_user_id: "39bbb0aa-8557-4626-a228-3ed7580bf6ea",
            currency: "usd",
            expires_at: null,
            id: ids.cart,
            subtotal_cents: 0,
            user_id: "user_123"
          }
        ]
      };
    }
    if (text.includes("authenticated_user_id = $3")) {
      return { rows: [{ id: ids.cart }] };
    }
    if (text.includes("select subtotal_cents from carts")) {
      return { rows: [{ subtotal_cents: 0 }] };
    }
    if (text.includes("validation_status <> 'valid'")) {
      return { rows: [] };
    }
    if (text.includes("from cart_items ci") && text.includes("join listings")) {
      return { rows: [] };
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

function cartView(overrides: Record<string, unknown> = {}) {
  return {
    cartId: ids.cart,
    cartItemId: ids.cartItem,
    items: [],
    lineItemCount: 1,
    revision: 4,
    subtotalCents: 8500,
    totalQuantity: 1,
    ...overrides
  };
}

function createCartServiceDouble(overrides: Record<string, unknown> = {}) {
  return {
    addGuestItem: vi.fn(async (_context: unknown, _input: unknown, _key: string) =>
      cartView(),
    ),
    getAuthenticatedCart: vi.fn(async () => cartView({ warnings: [] })),
    getAuthenticatedCartSummary: vi.fn(async () => ({
      cartId: ids.cart,
      lineItemCount: 1,
      revision: 4,
      totalQuantity: 1
    })),
    getGuestCart: vi.fn(async () => cartView()),
    getGuestCartSummary: vi.fn(async () => ({
      cartId: ids.cart,
      lineItemCount: 1,
      revision: 4,
      totalQuantity: 1
    })),
    removeGuestItem: vi.fn(async () => cartView({
      cartItemId: undefined,
      lineItemCount: 0,
      revision: 5,
      subtotalCents: 0,
      totalQuantity: 0
    })),
    updateGuestItem: vi.fn(async () => cartView()),
    ...overrides
  };
}

function capturedLogger() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    stream: {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  };
}

async function registerInjectedCartPlugin({
  app,
  database,
  redis,
  service
}: {
  app: ReturnType<typeof fastify>;
  database: Pool;
  redis: RedisClientType;
  service: ReturnType<typeof createCartServiceDouble>;
}) {
  await app.register(cookie);
  await app.register(authPlugin);
  app.decorate("pg", database);
  app.decorate("redis", redis);
  await app.register(
    createCartPlugin({
      cartServiceFactory: () => service as never
    }),
  );
}

describe("cartPlugin", () => {
  beforeEach(() => {
    mocks.verifyClerkToken.mockReset();
  });

  it.each(["/cart", "/cart/"])(
    "serves the cart root at %s after proxy path normalization",
    async (url) => {
      const { database } = createDatabaseMock();
      const { redis } = createRedisMock();
      const app = fastify({ logger: false });
      await app.register(cookie);
      await app.register(authPlugin);
      app.decorate("pg", database);
      app.decorate("redis", redis);
      await app.register(cartPlugin, { prefix: "/cart" });

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], subtotalCents: 0 });
      await app.close();
    },
  );

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
    expect(body).toMatchObject({
      items: [],
      lineItemCount: 0,
      revision: 0,
      subtotalCents: 0,
      totalQuantity: 0
    });
    expect(queries[0].text).toContain("insert into carts");
    expect(queries[0].values[0]).toBe(body.cartId);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toMatch(/^guest_session:[a-f0-9]{64}$/);
    expect(JSON.parse(writes[0].value).cartId).toBe(body.cartId);
    expect(gets).toEqual([]);
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
    expect(response.json()).toEqual({
      items: [],
      lineItemCount: 0,
      revision: 0,
      subtotalCents: 0,
      totalQuantity: 0,
      warnings: []
    });
    expect(queries.some(({ text }) => text.includes("left join users"))).toBe(true);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(mocks.verifyClerkToken).toHaveBeenCalledWith("verified-token");

    await app.close();
  });

  it("requires authentication for explicit cart claims", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", database);
    app.decorate("redis", redis);
    await app.register(cartPlugin);

    const response = await app.inject({ method: "POST", url: "/claim" });

    expect(response.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);

    await app.close();
  });

  it("returns the current authenticated cart for a repeated no-guest claim", async () => {
    const { database, queries, release } = createClaimDatabaseMock();
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
      headers: {
        authorization: "Bearer verified-token",
        cookie: `session_id=${guestSessionId}`
      },
      method: "POST",
      url: "/claim"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cartId: ids.cart,
      items: [],
      lineItemCount: 0,
      revision: 0,
      subtotalCents: 0,
      totalQuantity: 0,
      warnings: []
    });
    expect(
      queries.some(({ text }) => text.includes("insert into cart_items")),
    ).toBe(false);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toContain("session_id=;");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    expect(release).toHaveBeenCalledOnce();

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
    expect(writes).toHaveLength(0);
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
        priorityCode: "standard",
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
      headers: { "idempotency-key": "reject-client-pricing-1" },
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
        priorityCode: "standard",
        quantity: 1,
        unitAmountCents: 1
      }
    });

    expect(response.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
    expect(writes).toHaveLength(0);

    await app.close();
  });

  it("returns a canonical guest summary without creating cart state", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const service = createCartServiceDouble();
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({ method: "GET", url: "/summary" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      lineItemCount: 0,
      revision: 0,
      totalQuantity: 0
    });
    expect(service.getGuestCartSummary).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it("reads an authenticated summary without creating a guest cart", async () => {
    const { database, queries } = createDatabaseMock();
    const { gets, redis, writes } = createRedisMock();
    const service = createCartServiceDouble();
    const app = fastify({ logger: false });
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "authenticated-session",
      token: "test-token",
      userId: "user_123"
    });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/summary"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cartId: ids.cart,
      lineItemCount: 1,
      revision: 4,
      totalQuantity: 1
    });
    expect(service.getAuthenticatedCartSummary).toHaveBeenCalledWith("user_123");
    expect(service.getGuestCartSummary).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(gets).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it.each([
    ["contains spaces", "INVALID_IDEMPOTENCY_KEY"],
    [`a${"b".repeat(128)}`, "INVALID_IDEMPOTENCY_KEY"]
  ])("rejects an invalid Idempotency-Key before cart creation", async (key, code) => {
    const { database, queries } = createDatabaseMock();
    const { redis, writes } = createRedisMock();
    const service = createCartServiceDouble();
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      headers: key ? { "idempotency-key": key } : undefined,
      method: "POST",
      payload: cartItemPayload(),
      url: "/items"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: code, statusCode: 400 });
    expect(service.addGuestItem).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it("generates a one-request idempotency key for a legacy client", async () => {
    const { database } = createMutationDatabaseMock();
    const { redis, seed } = createRedisMock();
    const service = createCartServiceDouble();
    seed(
      guestSessionKey,
      JSON.stringify({
        cartId: ids.cart,
        createdAt: "2026-08-01T12:00:00.000Z"
      }),
    );
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      cookies: { session_id: guestSessionId },
      method: "POST",
      payload: cartItemPayload(),
      url: "/items"
    });

    expect(response.statusCode).toBe(201);
    expect(service.addGuestItem).toHaveBeenCalledOnce();
    expect(service.addGuestItem.mock.calls[0]?.[2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await app.close();
  });

  it("passes a replayed idempotency key through and returns the durable result", async () => {
    const { database } = createMutationDatabaseMock();
    const { redis, seed } = createRedisMock();
    const service = createCartServiceDouble();
    seed(
      guestSessionKey,
      JSON.stringify({
        cartId: ids.cart,
        createdAt: "2026-08-01T12:00:00.000Z"
      }),
    );
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });
    const request = {
      cookies: { session_id: guestSessionId },
      headers: { "idempotency-key": "add-stole-replay-1" },
      method: "POST" as const,
      payload: cartItemPayload(),
      url: "/items"
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(service.addGuestItem).toHaveBeenCalledTimes(2);
    expect(service.addGuestItem.mock.calls.map((call) => call[2])).toEqual([
      "add-stole-replay-1",
      "add-stole-replay-1"
    ]);

    await app.close();
  });

  it("maps reuse with a different payload to CART_IDEMPOTENCY_CONFLICT", async () => {
    const { database } = createMutationDatabaseMock();
    const { redis, seed } = createRedisMock();
    const addGuestItem = vi
      .fn()
      .mockResolvedValueOnce(cartView())
      .mockRejectedValueOnce(new CartIdempotencyConflictError());
    const service = createCartServiceDouble({ addGuestItem });
    seed(
      guestSessionKey,
      JSON.stringify({
        cartId: ids.cart,
        createdAt: "2026-08-01T12:00:00.000Z"
      }),
    );
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });
    const headers = { "idempotency-key": "add-stole-conflict-1" };

    const first = await app.inject({
      cookies: { session_id: guestSessionId },
      headers,
      method: "POST",
      payload: cartItemPayload(),
      url: "/items"
    });
    const conflict = await app.inject({
      cookies: { session_id: guestSessionId },
      headers,
      method: "POST",
      payload: { ...cartItemPayload(), line1: "Different private text" },
      url: "/items"
    });

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: "CART_IDEMPOTENCY_CONFLICT",
      message: "This idempotency key was already used for a different cart item.",
      statusCode: 409
    });

    await app.close();
  });

  it("maps an unavailable production option to INVALID_PRODUCTION_PRIORITY", async () => {
    const { database } = createMutationDatabaseMock();
    const { redis } = createRedisMock();
    const service = createCartServiceDouble({
      addGuestItem: vi.fn().mockRejectedValue(new InvalidProductionPriorityError()),
    });
    const app = fastify({ logger: false });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      headers: { "idempotency-key": "invalid-production-option-1" },
      method: "POST",
      payload: cartItemPayload(),
      url: "/items",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "INVALID_PRODUCTION_PRIORITY",
      message: "The selected production priority is unavailable.",
    });
    await app.close();
  });

  it("emits request-correlated summary metrics from request.log", async () => {
    const { records, stream } = capturedLogger();
    const { database } = createDatabaseMock();
    const { redis } = createRedisMock();
    const service = createCartServiceDouble();
    const app = fastify({
      genReqId: (request) => String(request.headers["x-request-id"]),
      logger: { level: "info", stream },
      requestIdLogLabel: "requestId"
    });
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "authenticated-session",
      token: "test-token",
      userId: "user_123"
    });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      headers: {
        authorization: "Bearer verified-token",
        "x-request-id": "cart-summary-request-1"
      },
      method: "GET",
      url: "/summary"
    });
    const event = records.find((record) => record.event === "cart.read.completed");

    expect(response.statusCode).toBe(200);
    expect(event).toMatchObject({
      actorType: "authenticated",
      cartId: ids.cart,
      event: "cart.read.completed",
      lineItemCount: 1,
      operation: "summary",
      requestId: "cart-summary-request-1",
      revision: 4,
      totalQuantity: 1
    });
    expect(event?.durationMs).toEqual(expect.any(Number));

    await app.close();
  });

  it("logs one privacy-safe event for a handled cart validation failure", async () => {
    const { records, stream } = capturedLogger();
    const { database } = createDatabaseMock();
    const { redis } = createRedisMock();
    const service = createCartServiceDouble();
    const app = fastify({
      genReqId: (request) => String(request.headers["x-request-id"]),
      logger: { level: "info", stream },
      requestIdLogLabel: "requestId"
    });
    await registerInjectedCartPlugin({ app, database, redis, service });

    const response = await app.inject({
      headers: {
        "idempotency-key": "private-idempotency-key",
        "x-request-id": "cart-validation-request-1"
      },
      method: "POST",
      payload: {
        ...cartItemPayload(),
        customerEmail: "private@example.com",
        line1: "Private graduation text",
        originalFilename: "private-crest.png"
      },
      url: "/items"
    });
    const events = records.filter(
      (record) => record.event === "cart.operation.failed",
    );

    expect(response.statusCode).toBe(400);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "guest",
      errorCode: "VALIDATION_ERROR",
      errorType: "ValidationError",
      event: "cart.operation.failed",
      operation: "add",
      requestId: "cart-validation-request-1",
      statusCode: 400
    });
    const serializedEvent = JSON.stringify(events[0]);
    expect(serializedEvent).not.toContain("private-idempotency-key");
    expect(serializedEvent).not.toContain("private@example.com");
    expect(serializedEvent).not.toContain("Private graduation text");
    expect(serializedEvent).not.toContain("private-crest.png");
    expect(service.addGuestItem).not.toHaveBeenCalled();

    await app.close();
  });
});
