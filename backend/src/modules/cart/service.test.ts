import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
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
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const { CartService } = await import("./service.js");

const ids = {
  asset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  cart: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  cartItem: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  fabric: "73fd9cf5-b96f-4664-a311-f3f5830cd9c1",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  reservation: "6dedaf90-15f0-45b2-a4c1-8f5ba86150dc",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};
const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
const expiresAt = "2027-08-01T12:00:00.000Z";

function input() {
  return {
    fabricId: null,
    imageAssetId: null,
    line1: "Class of 2027",
    line2: "Kapchi University",
    listingCustomizationSetId: ids.customizationSet,
    listingId: ids.listing,
    listingPriceVariantId: ids.variant,
    quantity: 2
  };
}

function projectionRow() {
  return {
    cart_item_id: ids.cartItem,
    listing_id: ids.listing,
    listing_slug: "graduation-stole",
    title: "Graduation Stole",
    quantity: 2,
    unit_amount_cents: 8500,
    currency: "usd",
    fabric_id: null,
    customization_set_id: ids.customizationSet,
    customization_payload: {
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University"
    },
    customization_asset_id: null,
    validation_status: "valid"
  };
}

function createPool({ authorized = true } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });

    if (["begin", "commit", "rollback"].includes(sql)) {
      return { rows: [] };
    }
    if (sql.includes("from carts") && sql.includes("for update")) {
      return {
        rows: authorized
          ? [
              {
                id: ids.cart,
                currency: "usd",
                expires_at: expiresAt,
                subtotal_cents: 0
              }
            ]
          : []
      };
    }
    if (sql.includes("select count(*)")) {
      return { rows: [{ count: 0 }] };
    }
    if (sql.includes("from listings l")) {
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
    if (sql.includes("insert into cart_items")) {
      return { rows: [{ id: ids.cartItem }] };
    }
    if (sql.includes("update carts c")) {
      return { rows: [{ subtotal_cents: 17000 }] };
    }
    if (sql.includes("from cart_items ci") && sql.includes("join listings")) {
      return { rows: [projectionRow()] };
    }

    return { rows: [] };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn()
  } as unknown as Pool;

  return { calls, pool, query, release };
}

function createRedis(setError?: Error) {
  const setEx = vi.fn(async (_key: string, _ttl: number, _value: string) => {
    if (setError) {
      throw setError;
    }
    return "OK";
  });
  const redis = {
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    setEx
  } as unknown as RedisClientType;
  return { redis, setEx };
}

function createCustomPool(
  handler: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  const query = vi.fn(handler);
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn()
  } as unknown as Pool;
  return { pool, query };
}

describe("CartService guest mutations", () => {
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    logger.warn.mockReset();
  });

  it("locks hashed durable ownership and persists server-derived pricing", async () => {
    const { calls, pool, query, release } = createPool();
    const { redis, setEx } = createRedis();
    const service = new CartService(pool, redis, logger as never);

    const result = await service.addGuestItem(
      { cartId: ids.cart, sessionId },
      input(),
    );

    expect(result).toMatchObject({
      cartId: ids.cart,
      cartItemId: ids.cartItem,
      subtotalCents: 17000
    });
    const lockCall = calls.find(({ sql }) => sql.includes("from carts"));
    expect(lockCall?.values).toEqual([
      ids.cart,
      createHash("sha256").update(sessionId).digest("hex")
    ]);
    const insertCall = calls.find(({ sql }) => sql.includes("insert into cart_items"));
    expect(insertCall?.values[6]).toBe(8500);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(setEx).toHaveBeenCalledOnce();
    expect(JSON.parse(String(setEx.mock.calls[0][2]))[0]).not.toHaveProperty(
      "privateUrl",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back without writing Redis when durable ownership fails", async () => {
    const { pool, query } = createPool({ authorized: false });
    const { redis, setEx } = createRedis();
    const service = new CartService(pool, redis, logger as never);

    await expect(
      service.addGuestItem({ cartId: ids.cart, sessionId }, input()),
    ).rejects.toMatchObject({ name: "CartNotFoundError" });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(setEx).not.toHaveBeenCalled();
  });

  it("keeps the committed mutation when disposable cache refresh fails", async () => {
    const { pool, query } = createPool();
    const { redis } = createRedis(new Error("redis://secret-host unavailable"));
    const service = new CartService(pool, redis, logger as never);

    const result = await service.addGuestItem(
      { cartId: ids.cart, sessionId },
      input(),
    );

    expect(result.cartItemId).toBe(ids.cartItem);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        cartId: ids.cart,
        cacheError: { name: "Error" }
      },
      "Guest cart projection refresh failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-host");
  });

  it("releases fabric inventory and an unreferenced asset when removing a line", async () => {
    const { pool, query } = createCustomPool(async (sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts") && sql.includes("for update")) {
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
      if (sql.includes("from cart_items") && sql.includes("for update")) {
        return {
          rows: [
            {
              id: ids.cartItem,
              fabric_id: ids.fabric,
              quantity: 1,
              customization_asset_id: ids.asset
            }
          ]
        };
      }
      if (sql.includes("from fabric_reservations")) {
        return {
          rows: [
            {
              id: ids.reservation,
              fabric_id: ids.fabric,
              quantity: 1
            }
          ]
        };
      }
      if (sql.includes("update carts c")) {
        return { rows: [{ subtotal_cents: 0 }] };
      }
      return { rows: [] };
    });
    const { redis } = createRedis();
    const service = new CartService(pool, redis, logger as never);

    const result = await service.removeGuestItem(
      { cartId: ids.cart, sessionId },
      ids.cartItem,
    );

    expect(result.items).toEqual([]);
    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.findIndex((statement) => statement.includes("status = 'released'"))).toBeLessThan(
      sql.findIndex((statement) => statement.includes("delete from cart_items")),
    );
    expect(sql.some((statement) => statement.includes("set status = 'uploaded'"))).toBe(
      true,
    );
    expect(sql.at(-1)).toBe("commit");
  });

  it("rolls back an update when fabric inventory cannot cover the new quantity", async () => {
    const { pool, query } = createCustomPool(async (sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts") && sql.includes("for update")) {
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
      if (sql.includes("from cart_items") && sql.includes("for update")) {
        return {
          rows: [
            {
              id: ids.cartItem,
              fabric_id: ids.fabric,
              quantity: 1,
              customization_asset_id: null
            }
          ]
        };
      }
      if (sql.includes("from fabric_reservations")) {
        return {
          rows: [
            {
              id: ids.reservation,
              fabric_id: ids.fabric,
              quantity: 1
            }
          ]
        };
      }
      if (sql.includes("from listings l")) {
        return {
          rows: [
            {
              currency: "usd",
              customization_enabled: true,
              listing_status: "active",
              max_chars: 120,
              min_chars: 0,
              price_variant_active: true,
              requires_fabric: true,
              requires_image: false,
              requires_text: true,
              unit_amount_cents: 8500
            }
          ]
        };
      }
      if (sql.includes("from fabrics f")) {
        return {
          rows: [
            {
              id: ids.fabric,
              listing_fabric_active: true,
              quantity_on_hand: 2,
              quantity_reserved: 1,
              status: "active"
            }
          ]
        };
      }
      if (sql.includes("update fabrics") && sql.includes("returning id")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { redis, setEx } = createRedis();
    const service = new CartService(pool, redis, logger as never);

    await expect(
      service.updateGuestItem(
        { cartId: ids.cart, sessionId },
        ids.cartItem,
        { ...input(), fabricId: ids.fabric, quantity: 3 },
      ),
    ).rejects.toMatchObject({ name: "CartConflictError" });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(setEx).not.toHaveBeenCalled();
  });
});
