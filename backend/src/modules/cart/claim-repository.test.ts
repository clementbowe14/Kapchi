import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

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
  STRIPE_CHECKOUT_CANCEL_URL: "https://kapchi.test/cart",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://kapchi.test/orders",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const { CartClaimRepository } = await import("./claim-repository.js");

const ids = {
  accountCart: "c870f199-67b2-4a66-b1af-059a8c723e99",
  asset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  contact: "fd7ff52f-6bbf-4d39-ab92-f930d782db58",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  customer: "1e1430a4-ab5e-4425-a2f6-3c6718ec23ef",
  destinationItem: "5863e978-6764-41f4-96bd-ea2337d11204",
  fabric: "73fd9cf5-b96f-4664-a311-f3f5830cd9c1",
  guestCart: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  reservation: "6dedaf90-15f0-45b2-a4c1-8f5ba86150dc",
  sourceItem: "0f82fc95-66a-41b9-9ed5-05a5a20e6f61",
  user: "39bbb0aa-8557-4626-a228-3ed7580bf6ea",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};
const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
const guestContext = { cartId: ids.guestCart, sessionId };
const identity = {
  authSubject: "user_clerk_123",
  avatarUrl: null,
  displayName: "Kapchi Customer",
  email: "customer@example.com",
  phone: null
};

function cartRow(id: string) {
  return {
    authenticated_user_id: id === ids.accountCart ? ids.user : null,
    currency: "usd",
    expires_at:
      id === ids.guestCart ? "2026-08-08T12:00:00.000Z" : null,
    id,
    revision: 2,
    subtotal_cents: 8500,
    user_id: id === ids.accountCart ? identity.authSubject : null
  };
}

function line(
  id: string,
  cartId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    cart_id: cartId,
    customization_asset_id: null,
    customization_payload: {
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University"
    },
    currency: "usd",
    fabric_id: null,
    id,
    listing_customization_set_id: ids.customizationSet,
    listing_id: ids.listing,
    listing_price_variant_id: ids.variant,
    quantity: 1,
    unit_amount_cents: 8500,
    validation_message: null,
    validation_status: "valid",
    ...overrides
  };
}

function projection(id: string, quantity = 1, status = "valid") {
  return {
    cart_item_id: id,
    listing_id: ids.listing,
    listing_slug: "graduation-stole",
    title: "Graduation Stole",
    quantity,
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
    validation_status: status
  };
}

function createPool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) =>
    handler(sql, values),
  );
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn()
  } as unknown as Pool;
  return { pool, query, release };
}

function identityResult(sql: string) {
  if (sql.includes("insert into users")) {
    return { rows: [{ disabled_at: null, id: ids.user }] };
  }
  if (sql.includes("select id from users")) {
    return { rows: [{ id: ids.user }] };
  }
  if (sql.includes("insert into customers")) {
    return { rows: [{ id: ids.customer }] };
  }
  if (sql.includes("insert into customer_contacts")) {
    return { rows: [{ id: ids.contact }] };
  }
  return null;
}

function commonViewResult(
  sql: string,
  cartId: string,
  projectionRows: unknown[],
  warningRows: unknown[] = [],
) {
  if (sql.includes("sum(quantity::bigint")) {
    return { rows: [{ subtotal_cents: "17000" }] };
  }
  if (sql.includes("set subtotal_cents = $2")) {
    return { rows: [{ id: cartId }] };
  }
  if (sql.includes("select subtotal_cents, revision from carts")) {
    return { rows: [{ revision: 3, subtotal_cents: 17000 }] };
  }
  if (sql.includes("validation_status <> 'valid'")) {
    return { rows: warningRows };
  }
  if (sql.includes("from cart_items ci") && sql.includes("join listings")) {
    return { rows: projectionRows };
  }
  return null;
}

describe("CartClaimRepository", () => {
  it("claims the guest cart in place when the account has no active cart", async () => {
    const source = line(ids.sourceItem, ids.guestCart);
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: [source] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.guestCart }] };
      }
      const view = commonViewResult(
        sql,
        ids.guestCart,
        [projection(ids.sourceItem)],
      );
      if (view) return view;
      return { rows: [] };
    });

    const result = await new CartClaimRepository(pool).claim(identity, guestContext);

    expect(result).toMatchObject({
      cartId: ids.guestCart,
      lineItemCount: 1,
      revision: 3,
      subtotalCents: 17000,
      totalQuantity: 1,
      warnings: []
    });
    const ownerUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("authenticated_user_id = $3"),
    );
    expect(ownerUpdate?.[1]).toEqual([
      ids.guestCart,
      identity.authSubject,
      ids.user,
      ids.customer,
      ids.contact
    ]);
    expect(String(ownerUpdate?.[0])).toContain("guest_token_hash = null");
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("combines deterministic equal lines and abandons the merged-away cart", async () => {
    const destination = line(ids.destinationItem, ids.accountCart, { quantity: 2 });
    const source = line(ids.sourceItem, ids.guestCart);
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: values[0] === ids.accountCart ? [destination] : [source] };
      }
      if (sql.includes("from fabric_reservations")) return { rows: [] };
      if (sql.includes("quantity = $3") && sql.includes("returning id")) {
        return { rows: [{ id: ids.destinationItem }] };
      }
      if (sql.includes("delete from cart_items")) {
        return { rows: [{ id: ids.sourceItem }] };
      }
      if (sql.includes("set status = 'abandoned'")) {
        return { rows: [{ id: ids.guestCart }] };
      }
      const view = commonViewResult(
        sql,
        ids.accountCart,
        [projection(ids.destinationItem, 3)],
      );
      if (view) return view;
      return { rows: [] };
    });

    const result = await new CartClaimRepository(pool).claim(identity, guestContext);

    const quantityUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("quantity = $3"),
    );
    expect(quantityUpdate?.[1]?.[2]).toBe(3);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("delete from cart_items")),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("guest_token_hash = null")),
    ).toBe(true);
    const sourceAbandonment = query.mock.calls.find(([sql]) =>
      String(sql).includes("status = 'abandoned'"),
    );
    expect(sourceAbandonment?.[1]).toEqual([
      ids.guestCart,
      identity.authSubject,
      ids.user,
      ids.customer,
      ids.contact
    ]);
    expect(String(sourceAbandonment?.[0])).toContain("authenticated_user_id = $3");
    expect(result).toMatchObject({
      lineItemCount: 1,
      revision: 3,
      totalQuantity: 3
    });
    expect(result.items[0]?.quantity).toBe(3);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("keeps an equal line separate when combining would exceed quantity 999", async () => {
    const destination = line(ids.destinationItem, ids.accountCart, { quantity: 999 });
    const source = line(ids.sourceItem, ids.guestCart, {
      validation_message: "The stored price changed.",
      validation_status: "needs_reprice"
    });
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: values[0] === ids.accountCart ? [destination] : [source] };
      }
      if (sql.includes("from fabric_reservations")) return { rows: [] };
      if (sql.includes("set\n            cart_id = $2")) {
        return { rows: [{ id: ids.sourceItem }] };
      }
      if (sql.includes("set status = 'abandoned'")) {
        return { rows: [{ id: ids.guestCart }] };
      }
      const view = commonViewResult(
        sql,
        ids.accountCart,
        [
          projection(ids.destinationItem, 999),
          projection(ids.sourceItem, 1, "needs_reprice")
        ],
        [
          {
            id: ids.sourceItem,
            validation_message: "The stored price changed.",
            validation_status: "needs_reprice"
          }
        ],
      );
      if (view) return view;
      return { rows: [] };
    });

    const result = await new CartClaimRepository(pool).claim(identity, guestContext);

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("quantity = $3")),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("cart_id = $2") &&
        String(sql).includes("validation_status = $3"),
      ),
    ).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result).toMatchObject({ lineItemCount: 2, totalQuantity: 1000 });
    expect(result.warnings).toEqual([
      {
        cartItemId: ids.sourceItem,
        message: "The stored price changed.",
        status: "needs_reprice"
      }
    ]);
  });

  it("returns the current account cart idempotently when no guest cart remains", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      const view = commonViewResult(
        sql,
        ids.accountCart,
        [projection(ids.destinationItem)],
      );
      if (view) return view;
      return { rows: [] };
    });

    const result = await new CartClaimRepository(pool).claim(identity, null);

    expect(result).toMatchObject({
      cartId: ids.accountCart,
      lineItemCount: 1,
      revision: 3,
      totalQuantity: 1
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("update cart_items") ||
        String(sql).includes("delete from cart_items"),
      ),
    ).toBe(false);
  });

  it("moves a separate line with its referenced asset and active reservation", async () => {
    const destination = line(ids.destinationItem, ids.accountCart, {
      customization_payload: {
        imageAssetId: null,
        line1: "Different text",
        line2: "Kapchi University"
      }
    });
    const source = line(ids.sourceItem, ids.guestCart, {
      customization_asset_id: ids.asset,
      customization_payload: {
        imageAssetId: ids.asset,
        line1: "Class of 2027",
        line2: "Kapchi University"
      },
      fabric_id: ids.fabric
    });
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: values[0] === ids.accountCart ? [destination] : [source] };
      }
      if (sql.includes("from fabric_reservations")) {
        return values[0] === ids.sourceItem
          ? {
              rows: [
                {
                  cart_id: ids.guestCart,
                  expires_at: "2026-08-08T12:00:00.000Z",
                  fabric_id: ids.fabric,
                  id: ids.reservation,
                  quantity: 1,
                  unexpired: true
                }
              ]
            }
          : { rows: [] };
      }
      if (sql.includes("update fabric_reservations")) {
        return { rows: [{ id: ids.reservation }] };
      }
      if (
        sql.includes("update cart_items") &&
        sql.includes("cart_id = $2")
      ) {
        return { rows: [{ id: ids.sourceItem }] };
      }
      if (sql.includes("update assets")) {
        return { rows: [{ id: ids.asset }] };
      }
      if (sql.includes("set status = 'abandoned'")) {
        return { rows: [{ id: ids.guestCart }] };
      }
      const view = commonViewResult(sql, ids.accountCart, [
        projection(ids.destinationItem),
        projection(ids.sourceItem)
      ]);
      if (view) return view;
      return { rows: [] };
    });

    await new CartClaimRepository(pool).claim(identity, guestContext);

    const reservationMove = query.mock.calls.find(([sql]) =>
      String(sql).includes("update fabric_reservations"),
    );
    expect(reservationMove?.[1]).toEqual([
      ids.reservation,
      ids.accountCart,
      ids.guestCart
    ]);
    const assetMove = query.mock.calls.find(([sql]) =>
      String(sql).includes("update assets"),
    );
    expect(assetMove?.[1]).toEqual([
      ids.asset,
      ids.accountCart,
      ids.user,
      identity.authSubject,
      ids.guestCart
    ]);
    expect(String(assetMove?.[0])).toContain("context = 'customization_image'");
    expect(String(assetMove?.[0])).toContain("visibility = 'private'");
    expect(String(assetMove?.[0])).toContain("status in ('uploaded', 'attached')");
    expect(String(assetMove?.[0])).toContain("authenticated_user_id is null");
    expect(String(assetMove?.[0])).toContain("created_by_auth_subject is null");
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("moves and releases an expired reservation with an unavailable warning", async () => {
    const source = line(ids.sourceItem, ids.guestCart, { fabric_id: ids.fabric });
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: values[0] === ids.accountCart ? [] : [source] };
      }
      if (sql.includes("from fabric_reservations")) {
        return {
          rows: [
            {
              cart_id: ids.guestCart,
              expires_at: "2026-07-31T12:00:00.000Z",
              fabric_id: ids.fabric,
              id: ids.reservation,
              quantity: 1,
              unexpired: false
            }
          ]
        };
      }
      if (sql.includes("update fabrics")) {
        return { rows: [{ id: ids.fabric }] };
      }
      if (sql.includes("update fabric_reservations")) {
        return { rows: [{ id: ids.reservation }] };
      }
      if (sql.includes("update cart_items") && sql.includes("cart_id = $2")) {
        return { rows: [{ id: ids.sourceItem }] };
      }
      if (sql.includes("set status = 'abandoned'")) {
        return { rows: [{ id: ids.guestCart }] };
      }
      const view = commonViewResult(
        sql,
        ids.accountCart,
        [projection(ids.sourceItem, 1, "unavailable")],
        [
          {
            id: ids.sourceItem,
            validation_message: "The selected fabric reservation is unavailable.",
            validation_status: "unavailable"
          }
        ],
      );
      if (view) return view;
      return { rows: [] };
    });

    const result = await new CartClaimRepository(pool).claim(identity, guestContext);

    const inventoryRelease = query.mock.calls.find(([sql]) =>
      String(sql).includes("update fabrics"),
    );
    expect(inventoryRelease?.[1]).toEqual([ids.fabric, 1]);
    expect(String(inventoryRelease?.[0])).toContain("quantity_reserved >= $2");
    const reservationRelease = query.mock.calls.find(([sql]) =>
      String(sql).includes("set status = 'released'"),
    );
    expect(reservationRelease?.[1]).toEqual([
      ids.reservation,
      ids.accountCart,
      ids.guestCart
    ]);
    expect(String(reservationRelease?.[0])).toContain("returning id");
    expect(result.warnings).toEqual([
      {
        cartItemId: ids.sourceItem,
        message: "The selected fabric reservation is unavailable.",
        status: "unavailable"
      }
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("rolls back when an invalid reservation cannot be released conditionally", async () => {
    const source = line(ids.sourceItem, ids.guestCart, { fabric_id: ids.fabric });
    const { pool, query } = createPool((sql, values) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [cartRow(ids.accountCart)] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (sql.includes("authenticated_user_id = $3")) {
        return { rows: [{ id: ids.accountCart }] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: values[0] === ids.accountCart ? [] : [source] };
      }
      if (sql.includes("from fabric_reservations")) {
        return {
          rows: [
            {
              cart_id: ids.guestCart,
              expires_at: "2026-07-31T12:00:00.000Z",
              fabric_id: ids.fabric,
              id: ids.reservation,
              quantity: 1,
              unexpired: false
            }
          ]
        };
      }
      if (sql.includes("update fabrics")) {
        return { rows: [{ id: ids.fabric }] };
      }
      if (sql.includes("update fabric_reservations")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      new CartClaimRepository(pool).claim(identity, guestContext),
    ).rejects.toMatchObject({
      message: "A fabric reservation changed during cart claim.",
      name: "CartClaimConflictError"
    });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("update cart_items") &&
        String(sql).includes("cart_id = $2"),
      ),
    ).toBe(false);
  });

  it("rolls back when a referenced guest asset cannot be moved conditionally", async () => {
    const source = line(ids.sourceItem, ids.guestCart, {
      customization_asset_id: ids.asset,
      customization_payload: {
        imageAssetId: ids.asset,
        line1: "Class of 2027",
        line2: "Kapchi University"
      }
    });
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      const resolvedIdentity = identityResult(sql);
      if (resolvedIdentity) return resolvedIdentity;
      if (sql.includes("authenticated_user_id = $1 or user_id = $2")) {
        return { rows: [] };
      }
      if (sql.includes("guest_token_hash = $2")) {
        return { rows: [cartRow(ids.guestCart)] };
      }
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci") &&
        sql.includes("for update")
      ) {
        return { rows: [source] };
      }
      if (sql.includes("update assets")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      new CartClaimRepository(pool).claim(identity, guestContext),
    ).rejects.toMatchObject({
      message: "A customization asset changed during claim.",
      name: "CartClaimConflictError"
    });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("guest_token_hash = null"),
      ),
    ).toBe(false);
  });
});
