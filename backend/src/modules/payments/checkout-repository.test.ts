import { describe, expect, it, vi } from "vitest";
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
  STRIPE_CHECKOUT_CANCEL_URL: "https://kapchi.test/cart",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://kapchi.test/orders",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const { CheckoutRepository } = await import("./checkout-repository.js");

const ids = {
  asset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  cart: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  cartItem: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};
const otherListingId = "7bcf3e94-f414-4fe8-b0fd-977b41a42a84";
const context = {
  cartId: ids.cart,
  sessionId: "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789"
};
const contact = {
  customerEmail: "customer@example.com",
  customerPhone: null
};

function cartRow() {
  return {
    authenticated_user_id: null,
    currency: "usd",
    customer_contact_id: null,
    customer_id: null,
    id: ids.cart,
    status: "active",
    subtotal_cents: 8500,
    user_id: null
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    asset_cart_id: null,
    asset_context: null,
    asset_listing_customization_set_id: null,
    asset_listing_id: null,
    asset_status: null,
    asset_visibility: null,
    cart_id: ids.cart,
    cart_item_id: ids.cartItem,
    currency: "usd",
    current_currency: "usd",
    current_unit_amount_cents: 8500,
    customization_asset_id: null,
    customization_enabled: true,
    customization_listing_id: ids.listing,
    customization_payload: {
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University"
    },
    fabric_color_name: null,
    fabric_id: null,
    fabric_listing_active: null,
    fabric_material: null,
    fabric_name: null,
    fabric_quantity_on_hand: null,
    fabric_quantity_reserved: null,
    fabric_reservation_fabric_id: null,
    fabric_reservation_quantity: null,
    fabric_sku: null,
    fabric_status: null,
    listing_customization_set_id: ids.customizationSet,
    listing_id: ids.listing,
    listing_price_variant_id: ids.variant,
    listing_requires_fabric: false,
    listing_slug: "graduation-stole",
    listing_status: "active",
    listing_title: "Graduation Stole",
    max_chars: 120,
    min_chars: 0,
    quantity: 1,
    requires_image: false,
    requires_text: true,
    stripe_price_id: "price_test_stole",
    stripe_product_id: "prod_test_stole",
    unit_amount_cents: 8500,
    variant_active: true,
    variant_customization_set_id: ids.customizationSet,
    variant_listing_id: ids.listing,
    ...overrides
  };
}

function createPool(handler: (sql: string, values: unknown[]) => { rows: unknown[] }) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) =>
    handler(sql, values),
  );
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn()
  } as unknown as Pool;
  return { pool, query };
}

describe("CheckoutRepository", () => {
  it("commits needs_reprice without creating an order for a stale price", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [cartRow()] };
      }
      if (sql.includes("from orders")) {
        return { rows: [] };
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [itemRow({ current_unit_amount_cents: 9000 })] };
      }
      return { rows: [] };
    });
    const repository = new CheckoutRepository(pool);

    await expect(repository.prepareCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutNeedsReviewError"
    });

    const statusUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("update cart_items"),
    );
    expect(statusUpdate?.[1]).toEqual([
      ids.cartItem,
      "needs_reprice",
      "The cart price changed and must be reviewed.",
      ids.cart
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into orders")),
    ).toBe(false);
  });

  it.each([
    [
      "an optional image with invalid durable ownership",
      {
        asset_cart_id: otherListingId,
        asset_context: "customization_image",
        asset_listing_customization_set_id: ids.customizationSet,
        asset_listing_id: ids.listing,
        asset_status: "attached",
        asset_visibility: "private",
        customization_asset_id: ids.asset,
        customization_payload: {
          imageAssetId: ids.asset,
          line1: "Class of 2027",
          line2: "Kapchi University"
        }
      },
      "invalid"
    ],
    [
      "a price variant associated with another listing",
      { variant_listing_id: otherListingId },
      "unavailable"
    ]
  ] as const)("commits a review status for %s", async (_label, overrides, status) => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [cartRow()] };
      }
      if (sql.includes("from orders")) {
        return { rows: [] };
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [itemRow(overrides)] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(context, contact),
    ).rejects.toMatchObject({ name: "CheckoutNeedsReviewError" });

    const statusUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("update cart_items"),
    );
    expect(statusUpdate?.[1]?.[1]).toBe(status);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into orders")),
    ).toBe(false);
  });

  it("materializes safe order snapshots and transfers reservation references", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [cartRow()] };
      }
      if (sql.includes("from orders")) {
        return { rows: [] };
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [itemRow()] };
      }
      return { rows: [] };
    });
    const repository = new CheckoutRepository(pool);

    const result = await repository.prepareCheckout(context, contact);

    expect(result.lines).toEqual([
      expect.objectContaining({
        currency: "usd",
        quantity: 1,
        stripePriceId: "price_test_stole"
      })
    ]);
    const orderInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into orders"),
    );
    expect(orderInsert?.[1]?.[1]).toMatch(/^KAP-[A-F0-9]{12}$/);
    const itemInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into order_items"),
    );
    expect(JSON.parse(String(itemInsert?.[1]?.[11]))).toEqual({
      id: ids.listing,
      slug: "graduation-stole",
      title: "Graduation Stole"
    });
    expect(JSON.stringify(itemInsert?.[1])).not.toContain("url");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("set order_id = $2, order_item_id = $3"),
      ),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("rolls back before reading items when durable guest ownership fails", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const repository = new CheckoutRepository(pool);

    await expect(repository.prepareCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutCartNotFoundError"
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("from cart_items")),
    ).toBe(false);
  });

  it("recovers the existing durable order instead of materializing a duplicate", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [{ ...cartRow(), status: "checkout_started" }] };
      }
      if (sql.includes("from orders")) {
        return {
          rows: [
            {
              customer_email: "original@example.com",
              id: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
              stripe_checkout_session_id: "cs_test_existing"
            }
          ]
        };
      }
      if (sql.includes("from order_items")) {
        return {
          rows: [
            {
              currency: "usd",
              id: "5863e978-6764-41f4-96bd-ea2337d11204",
              quantity: 1,
              stripe_price_id: "price_test_stole"
            }
          ]
        };
      }
      return { rows: [] };
    });

    const result = await new CheckoutRepository(pool).prepareCheckout(context, contact);

    expect(result).toMatchObject({
      customerEmail: "original@example.com",
      existingStripeSessionId: "cs_test_existing",
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8"
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into orders")),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });
});
