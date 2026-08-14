import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

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

const { CartService, fingerprintCartItemInput } = await import("./service.js");

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
const idempotencyKey = "add-graduation-stole-1";
const expiresAt = "2027-08-01T12:00:00.000Z";

function input() {
  return {
    fabricId: null,
    fontOptionId: null,
    imageAssetId: null,
    line1: "Class of 2027",
    line2: "Kapchi University",
    listingCustomizationSetId: ids.customizationSet,
    listingId: ids.listing,
    listingPriceVariantId: ids.variant,
    quantity: 2,
    trimOptionId: null
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
    listing_price_variant_id: ids.variant,
    customization_payload: {
      fontOptionId: null,
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University",
      trimOptionId: null
    },
    customization_asset_id: null,
    validation_status: "valid"
  };
}

function displayItem() {
  return {
    cartItemId: ids.cartItem,
    listingId: ids.listing,
    listingSlug: "graduation-stole",
    title: "Graduation Stole",
    quantity: 2,
    unitAmountCents: 8500,
    currency: "usd",
    fabricId: null,
    customizationSetId: ids.customizationSet,
    listingPriceVariantId: ids.variant,
    customizationSummary: {
      fontOptionId: null,
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University",
      trimOptionId: null
    },
    validationStatus: "valid"
  } as const;
}

function createPool({
  authorized = true,
  cartExpiresAt = expiresAt,
  idempotencyFingerprint = null,
  revision = 0,
  subtotalCents = 0
}: {
  authorized?: boolean;
  cartExpiresAt?: string;
  idempotencyFingerprint?: string | null;
  revision?: number;
  subtotalCents?: number;
} = {}) {
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
                expires_at: cartExpiresAt,
                revision,
                subtotal_cents: subtotalCents
              }
            ]
          : []
      };
    }
    if (sql.includes("from cart_add_idempotency_keys")) {
      return {
        rows: idempotencyFingerprint
          ? [
              {
                cart_item_id: ids.cartItem,
                request_fingerprint: idempotencyFingerprint
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
    if (sql.includes("sum(ci.quantity::bigint")) {
      return { rows: [{ subtotal_cents: "17000" }] };
    }
    if (sql.includes("update carts")) {
      return { rows: [{ revision: 1, subtotal_cents: 17000 }] };
    }
    if (sql.includes("from cart_items ci") && sql.includes("join listings")) {
      return { rows: [projectionRow()] };
    }
    if (sql.includes("count(*)::integer as line_item_count")) {
      return { rows: [{ line_item_count: 1, total_quantity: "2" }] };
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

function createReadPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("begin") || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }
    if (sql.includes("from carts")) {
      return {
        rows: [
          {
            id: ids.cart,
            currency: "usd",
            expires_at: expiresAt,
            revision: 7,
            subtotal_cents: 17000
          }
        ]
      };
    }
    if (sql.includes("from cart_items ci") && sql.includes("join listings")) {
      return { rows: [projectionRow()] };
    }
    if (sql.includes("count(*)::integer as line_item_count")) {
      return { rows: [{ line_item_count: 1, total_quantity: "2" }] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn()
  } as unknown as Pool;

  return { pool, query };
}

describe("cart add fingerprint", () => {
  it("is stable across object insertion order and covers every fixed input field", () => {
    const original = input();
    const reordered = {
      trimOptionId: original.trimOptionId,
      quantity: original.quantity,
      listingPriceVariantId: original.listingPriceVariantId,
      listingId: original.listingId,
      listingCustomizationSetId: original.listingCustomizationSetId,
      line2: original.line2,
      line1: original.line1,
      imageAssetId: original.imageAssetId,
      fontOptionId: original.fontOptionId,
      fabricId: original.fabricId
    };

    expect(fingerprintCartItemInput(reordered)).toBe(
      fingerprintCartItemInput(original),
    );
    expect(
      fingerprintCartItemInput({ ...original, line2: `${original.line2}!` }),
    ).not.toBe(fingerprintCartItemInput(original));
  });
});

describe("CartService guest mutations", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks hashed ownership and persists pricing, idempotency, counts, and revision", async () => {
    const { calls, pool, query, release } = createPool();
    const service = new CartService(pool);

    const result = await service.addGuestItem(
      { cartId: ids.cart, sessionId },
      input(),
      idempotencyKey,
    );

    expect(result).toMatchObject({
      cartId: ids.cart,
      cartItemId: ids.cartItem,
      lineItemCount: 1,
      revision: 1,
      subtotalCents: 17000,
      totalQuantity: 2
    });
    const lockCall = calls.find(({ sql }) => sql.includes("from carts"));
    expect(lockCall?.values).toEqual([
      ids.cart,
      createHash("sha256").update(sessionId).digest("hex")
    ]);
    const insertCall = calls.find(({ sql }) => sql.includes("insert into cart_items"));
    expect(insertCall?.values[6]).toBe(8500);
    const idempotencyInsert = calls.find(({ sql }) =>
      sql.includes("insert into cart_add_idempotency_keys"),
    );
    expect(idempotencyInsert?.values).toEqual([
      ids.cart,
      idempotencyKey,
      fingerprintCartItemInput(input()),
      ids.cartItem
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back when durable ownership fails", async () => {
    const { pool, query } = createPool({ authorized: false });
    const service = new CartService(pool);

    await expect(
      service.addGuestItem(
        { cartId: ids.cart, sessionId },
        input(),
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ name: "CartNotFoundError" });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("rejects an invalid idempotency key before opening a transaction", async () => {
    const { pool } = createPool();
    const service = new CartService(pool);

    await expect(
      service.addGuestItem({ cartId: ids.cart, sessionId }, input(), ""),
    ).rejects.toMatchObject({ name: "CartValidationError" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("replays the original add result without another item or revision", async () => {
    const itemInput = input();
    const { calls, pool } = createPool({
      idempotencyFingerprint: fingerprintCartItemInput(itemInput),
      revision: 4,
      subtotalCents: 17000
    });
    const service = new CartService(pool);

    const result = await service.addGuestItem(
      { cartId: ids.cart, sessionId },
      itemInput,
      idempotencyKey,
    );

    expect(result).toMatchObject({
      cartItemId: ids.cartItem,
      lineItemCount: 1,
      revision: 4,
      subtotalCents: 17000,
      totalQuantity: 2
    });
    expect(calls.some(({ sql }) => sql.includes("insert into cart_items"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("update carts"))).toBe(false);
  });

  it("rejects reuse of an idempotency key with different fixed input", async () => {
    const { calls, pool } = createPool({
      idempotencyFingerprint: fingerprintCartItemInput(input())
    });
    const service = new CartService(pool);

    await expect(
      service.addGuestItem(
        { cartId: ids.cart, sessionId },
        { ...input(), quantity: 3 },
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ name: "CartIdempotencyConflictError" });
    expect(calls.some(({ sql }) => sql.includes("insert into cart_items"))).toBe(false);
  });

  it("locks an owned image and rolls back when conditional attachment loses the row", async () => {
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
                revision: 0,
                subtotal_cents: 0
            }
          ]
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
              requires_image: true,
              requires_text: true,
              unit_amount_cents: 8500
            }
          ]
        };
      }
      if (sql.includes("from assets a")) {
        return { rows: [{ id: ids.asset }] };
      }
      if (sql.includes("insert into cart_items")) {
        return { rows: [{ id: ids.cartItem }] };
      }
      if (sql.includes("update assets")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const service = new CartService(pool);

    await expect(
      service.addGuestItem(
        { cartId: ids.cart, sessionId },
        { ...input(), imageAssetId: ids.asset },
        idempotencyKey,
      ),
    ).rejects.toMatchObject({ name: "CartConflictError" });

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.find((statement) => statement.includes("from assets a"))).toContain(
      "for update of a",
    );
    expect(sql.find((statement) => statement.includes("update assets"))).toContain(
      "status in ('uploaded', 'attached')",
    );
    expect(sql.at(-1)).toBe("rollback");
  });

  it("rolls back before writing an overflowing subtotal", async () => {
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
                revision: 0,
                subtotal_cents: 0
            }
          ]
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
      if (sql.includes("sum(ci.quantity::bigint")) {
        return { rows: [{ subtotal_cents: "2147483648" }] };
      }
      return { rows: [] };
    });
    const service = new CartService(pool);

    await expect(
      service.addGuestItem(
        { cartId: ids.cart, sessionId },
        input(),
        idempotencyKey,
      ),
    ).rejects.toMatchObject({
      message: "Cart total exceeds the supported maximum.",
      name: "CartConflictError"
    });

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.includes("set subtotal_cents = $2"))).toBe(
      false,
    );
    expect(sql.at(-1)).toBe("rollback");
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
                revision: 3,
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
      if (sql.includes("sum(ci.quantity::bigint")) {
        return { rows: [{ subtotal_cents: "0" }] };
      }
      if (sql.includes("update carts")) {
        return { rows: [{ revision: 4, subtotal_cents: 0 }] };
      }
      return { rows: [] };
    });
    const service = new CartService(pool);

    const result = await service.removeGuestItem(
      { cartId: ids.cart, sessionId },
      ids.cartItem,
    );

    expect(result.items).toEqual([]);
    expect(result).toMatchObject({
      lineItemCount: 0,
      revision: 4,
      totalQuantity: 0
    });
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
                revision: 3,
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
    const service = new CartService(pool);

    await expect(
      service.updateGuestItem(
        { cartId: ids.cart, sessionId },
        ids.cartItem,
        { ...input(), fabricId: ids.fabric, quantity: 3 },
      ),
    ).rejects.toMatchObject({ name: "CartConflictError" });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });
});

describe("CartService guest display projection", () => {
  it("always reads the authoritative PostgreSQL projection in one snapshot", async () => {
    const { pool, query } = createReadPool();
    const service = new CartService(pool);

    const result = await service.getGuestCart({ cartId: ids.cart, sessionId });

    expect(result).toMatchObject({
      items: [displayItem()],
      lineItemCount: 1,
      revision: 7,
      subtotalCents: 17000,
      totalQuantity: 2
    });
    expect(query.mock.calls[0]?.[0]).toBe(
      "begin transaction isolation level repeatable read read only",
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("join listings")),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("returns canonical summary counts without creating a cart", async () => {
    const { pool, query } = createReadPool();
    const service = new CartService(pool);

    await expect(
      service.getGuestCartSummary({ cartId: ids.cart, sessionId }),
    ).resolves.toEqual({
      cartId: ids.cart,
      lineItemCount: 1,
      revision: 7,
      totalQuantity: 2
    });
    await expect(service.getGuestCartSummary(null)).resolves.toEqual({
      lineItemCount: 0,
      revision: 0,
      totalQuantity: 0
    });

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("count(*)::integer as line_item_count"),
      ),
    ).toBe(true);
  });
});
