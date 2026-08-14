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
  fabric: "73fd9cf5-b96f-4664-a311-f3f5830cd9c1",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  reservation: "6dedaf90-15f0-45b2-a4c1-8f5ba86150dc",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};
const otherListingId = "7bcf3e94-f414-4fe8-b0fd-977b41a42a84";
const context = {
  cartId: ids.cart,
  sessionId: "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789"
};
const contact = {
  customerEmail: "customer@example.com",
  customerPhone: null,
  preferredContactMethod: "email" as const
};

function cartRow() {
  return {
    authenticated_user_id: null,
    currency: "usd",
    customer_contact_id: null,
    customer_id: null,
    id: ids.cart,
    revision: 3,
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
      fontOptionId: null,
      imageAssetId: null,
      line1: "Class of 2027",
      line2: "Kapchi University",
      trimOptionId: null
    },
    fabric_color_name: null,
    fabric_id: null,
    fabric_listing_active: null,
    fabric_material: null,
    fabric_name: null,
    fabric_quantity_on_hand: null,
    fabric_quantity_reserved: null,
    fabric_reservation_id: null,
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

function mutableStateResult(
  sql: string,
  row: ReturnType<typeof itemRow>,
): { rows: unknown[] } | null {
  if (
    sql.includes("from cart_items") &&
    !sql.includes("from cart_items ci") &&
    sql.includes("for update")
  ) {
    return {
      rows: [
        {
          customization_asset_id: row.customization_asset_id,
          fabric_id: row.fabric_id,
          id: row.cart_item_id,
          listing_customization_set_id: row.listing_customization_set_id,
          listing_id: row.listing_id,
          listing_price_variant_id: row.listing_price_variant_id
        }
      ]
    };
  }
  if (sql.includes("from listings l") && sql.includes("for update")) {
    return { rows: [{ id: row.listing_id }] };
  }
  if (sql.includes("from fabrics f") && sql.includes("for update")) {
    return { rows: row.fabric_id ? [{ id: row.fabric_id }] : [] };
  }
  if (sql.includes("from fabric_reservations") && sql.includes("for update")) {
    return {
      rows: row.fabric_reservation_id
        ? [{ id: row.fabric_reservation_id }]
        : []
    };
  }
  if (sql.includes("from assets") && sql.includes("for update")) {
    return {
      rows: row.customization_asset_id
        ? [{ id: row.customization_asset_id }]
        : []
    };
  }
  return null;
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
    const row = itemRow({ current_unit_amount_cents: 9000 });
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
      const mutableState = mutableStateResult(sql, row);
      if (mutableState) {
        return mutableState;
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [row] };
      }
      return { rows: [] };
    });
    const repository = new CheckoutRepository(pool);

    await expect(repository.prepareCheckout(context, contact)).rejects.toMatchObject({
      issues: [
        {
          cartItemId: ids.cartItem,
          message: "The cart price changed and must be reviewed.",
          status: "needs_reprice"
        }
      ],
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
          fontOptionId: null,
          imageAssetId: ids.asset,
          line1: "Class of 2027",
          line2: "Kapchi University",
          trimOptionId: null
        }
      },
      "invalid"
    ],
    [
      "a quarantined optional customization image",
      {
        asset_cart_id: ids.cart,
        asset_context: "customization_image",
        asset_listing_customization_set_id: ids.customizationSet,
        asset_listing_id: ids.listing,
        asset_status: "quarantined",
        asset_visibility: "private",
        customization_asset_id: ids.asset,
        customization_payload: {
          fontOptionId: null,
          imageAssetId: ids.asset,
          line1: "Class of 2027",
          line2: "Kapchi University",
          trimOptionId: null
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
    const row = itemRow(overrides);
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
      const mutableState = mutableStateResult(sql, row);
      if (mutableState) {
        return mutableState;
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [row] };
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
    if (row.customization_asset_id) {
      expect(
        query.mock.calls.some(
          ([sql]) =>
            String(sql).includes("from assets") &&
            String(sql).includes("for update"),
        ),
      ).toBe(true);
    }
  });

  it("materializes safe order snapshots and transfers reservation references", async () => {
    const row = itemRow({
      fabric_color_name: "Royal Blue",
      fabric_id: ids.fabric,
      fabric_listing_active: true,
      fabric_material: "Satin",
      fabric_name: "Royal Blue Satin",
      fabric_quantity_on_hand: 20,
      fabric_quantity_reserved: 1,
      fabric_reservation_fabric_id: ids.fabric,
      fabric_reservation_id: ids.reservation,
      fabric_reservation_quantity: 1,
      fabric_sku: "FAB-BLUE",
      fabric_status: "active",
      listing_requires_fabric: true
    });
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
      const mutableState = mutableStateResult(sql, row);
      if (mutableState) {
        return mutableState;
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [row] };
      }
      if (
        sql.includes("update fabric_reservations") &&
        sql.includes("returning id")
      ) {
        return { rows: [{ id: ids.reservation }] };
      }
      return { rows: [] };
    });
    const repository = new CheckoutRepository(pool);

    const result = await repository.prepareCheckout(context, {
      ...contact,
      customerPhone: "+15550101010",
      preferredContactMethod: "phone"
    });

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
    expect(orderInsert?.[1]?.[8]).toBe("+15550101010");
    expect(orderInsert?.[1]?.[9]).toBe("phone");
    expect(result.publicOrderNumber).toBe(orderInsert?.[1]?.[1]);
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
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("for update of l, lcs, cs, lpv"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("for update of f, lf"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("from fabric_reservations") &&
        String(sql).includes("for update"),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("update fabric_reservations") &&
        String(sql).includes("returning id"),
      ),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("rolls back when a mutable catalog row cannot be locked exactly once", async () => {
    const row = itemRow();
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
      if (
        sql.includes("from cart_items") &&
        !sql.includes("from cart_items ci")
      ) {
        return mutableStateResult(sql, row) ?? { rows: [] };
      }
      if (sql.includes("from listings l") && sql.includes("for update")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(context, contact),
    ).rejects.toMatchObject({ name: "CheckoutNeedsReviewError" });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into orders")),
    ).toBe(false);
  });

  it("rolls back when reservation conversion loses its expected row", async () => {
    const row = itemRow({
      fabric_id: ids.fabric,
      fabric_listing_active: true,
      fabric_quantity_on_hand: 20,
      fabric_quantity_reserved: 1,
      fabric_reservation_fabric_id: ids.fabric,
      fabric_reservation_id: ids.reservation,
      fabric_reservation_quantity: 1,
      fabric_status: "active",
      listing_requires_fabric: true
    });
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
      const mutableState = mutableStateResult(sql, row);
      if (mutableState) {
        return mutableState;
      }
      if (sql.includes("from cart_items ci")) {
        return { rows: [row] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(context, contact),
    ).rejects.toMatchObject({
      message: "A fabric reservation changed while checkout was starting.",
      name: "CheckoutNeedsReviewError"
    });

    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("update fabric_reservations"),
      ),
    ).toBe(true);
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

  it("locks authenticated ownership through internal and legacy user identities", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts c")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(
        { authSubject: "user_clerk_123" },
        contact,
      ),
    ).rejects.toMatchObject({ name: "CheckoutCartNotFoundError" });

    const ownerLock = query.mock.calls.find(([sql]) =>
      String(sql).includes("from carts c"),
    );
    expect(String(ownerLock?.[0])).toContain("left join users");
    expect(String(ownerLock?.[0])).toContain("c.user_id = $1");
    expect(String(ownerLock?.[0])).toContain("c.status = 'active'");
    expect(String(ownerLock?.[0])).toContain("c.id = $2::uuid");
    expect(String(ownerLock?.[0])).toContain("for update of c");
    expect(String(ownerLock?.[0])).not.toContain("guest_token_hash");
    expect(ownerLock?.[1]).toEqual(["user_clerk_123", null]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("locks the exact authenticated cart requested by the client", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts c")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(
        { authSubject: "user_clerk_123", cartId: ids.cart },
        contact,
      ),
    ).rejects.toMatchObject({ name: "CheckoutCartNotFoundError" });

    const ownerLock = query.mock.calls.find(([sql]) =>
      String(sql).includes("from carts c"),
    );
    expect(ownerLock?.[1]).toEqual(["user_clerk_123", ids.cart]);
  });

  it("rejects checkout when the reviewed cart revision is stale", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts c")) {
        return { rows: [{ ...cartRow(), revision: 4 }] };
      }
      return { rows: [] };
    });

    await expect(
      new CheckoutRepository(pool).prepareCheckout(
        {
          authSubject: "user_clerk_123",
          cartId: ids.cart,
          expectedRevision: 3
        },
        contact,
      ),
    ).rejects.toMatchObject({ name: "CheckoutNeedsReviewError" });

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("from orders")),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
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
              public_order_number: "KAP-ORIGINAL1001",
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
      cartId: ids.cart,
      cartRevision: 3,
      cartStatus: "checkout_started",
      customerEmail: "original@example.com",
      existingStripeSessionId: "cs_test_existing",
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      publicOrderNumber: "KAP-ORIGINAL1001",
      reusedOrder: true
    });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into orders")),
    ).toBe(false);
    const existingOrderQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("from orders") && String(sql).includes("order_events"),
    );
    expect(String(existingOrderQuery?.[0])).toContain(
      "catalog_failure.event_type = 'checkout.catalog_unavailable'",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("loads status only through authenticated Clerk ownership", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({
      rows: [{
        id: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
        payment_status: "paid",
        public_order_number: "KAP-2DB9F8E1D0F0"
      }]
    }));
    const pool = { connect: vi.fn(), query } as unknown as Pool;

    const status = await new CheckoutRepository(pool).getCheckoutStatus(
      { authSubject: "user_clerk_123" },
      "cs_test_owned",
    );

    expect(status).toEqual({
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      paymentStatus: "paid",
      publicOrderNumber: "KAP-2DB9F8E1D0F0"
    });
    expect(String(query.mock.calls[0][0])).toContain("u.auth_subject = $2");
    expect(String(query.mock.calls[0][0])).toContain(
      "o.stripe_checkout_session_id = $1",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "cs_test_owned",
      "user_clerk_123"
    ]);
  });

  it("loads guest status only through the cart and hashed cookie", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({
      rows: []
    }));
    const pool = { connect: vi.fn(), query } as unknown as Pool;

    const status = await new CheckoutRepository(pool).getCheckoutStatus(
      context,
      "cs_test_guest",
    );

    expect(status).toBeNull();
    expect(String(query.mock.calls[0][0])).toContain("c.guest_token_hash = $3");
    expect(query.mock.calls[0][1]?.slice(0, 2)).toEqual([
      "cs_test_guest",
      ids.cart
    ]);
    expect(query.mock.calls[0][1]?.[2]).not.toBe(context.sessionId);
    expect(String(query.mock.calls[0][1]?.[2])).toHaveLength(64);
  });

  it("retires a terminal provider session and reactivates its eligible cart", async () => {
    const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from orders") && sql.includes("for update")) {
        return {
          rows: [
            {
              cart_id: ids.cart,
              payment_status: "checkout_started",
              status: "pending_payment",
              stripe_checkout_session_id: "cs_test_expired"
            }
          ]
        };
      }
      if (sql.includes("select id from carts")) {
        return { rows: [{ id: ids.cart }] };
      }
      if (sql.includes("update orders") && sql.includes("returning id")) {
        return { rows: [{ id: orderId }] };
      }
      return { rows: [] };
    });

    await new CheckoutRepository(pool).retireTerminalCheckout(
      orderId,
      {
        expiresAt: new Date("2026-08-01T12:00:00.000Z"),
        sessionId: "cs_test_expired"
      },
      "provider_session_expired",
    );

    const orderUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("status = 'cancelled'"),
    );
    expect(String(orderUpdate?.[0])).toContain("payment_status = 'failed'");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("set status = 'active'"),
      ),
    ).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("allows provider failure recovery from checkout_started payment state", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({
      rows: []
    }));
    const pool = { connect: vi.fn(), query } as unknown as Pool;

    await new CheckoutRepository(pool).markProviderFailure(
      "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
    );

    expect(String(query.mock.calls[0][0])).toContain(
      "payment_status in ('unpaid', 'checkout_started', 'failed')",
    );
  });

  it("atomically records one privacy-safe catalog-unavailable marker", async () => {
    const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from orders o")) {
        return {
          rows: [{
            cart_id: ids.cart,
            payment_status: "checkout_started",
            status: "pending_payment"
          }]
        };
      }
      if (sql.includes("from carts") && sql.includes("cart_recoverable")) {
        return {
          rows: [{
            authenticated_user_id: null,
            cart_recoverable: true,
            guest_token_hash: "guest-hash",
            status: "checkout_started",
            user_id: null
          }]
        };
      }
      return { rows: [] };
    });

    const disposition = await new CheckoutRepository(pool).markCatalogUnavailable(
      orderId,
    );

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const updateIndex = statements.findIndex((sql) =>
      sql.includes("update orders"),
    );
    const eventIndex = statements.findIndex((sql) =>
      sql.includes("insert into order_events"),
    );
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    expect(updateIndex).toBeGreaterThan(0);
    expect(eventIndex).toBeGreaterThan(updateIndex);
    expect(statements[updateIndex]).toContain("status = 'cancelled'");
    expect(statements[updateIndex]).toContain("payment_status = 'failed'");
    expect(
      query.mock.calls.some(([sql, values]) =>
        String(sql).includes("update carts") && values?.[1] === "active",
      ),
    ).toBe(true);
    expect(statements[eventIndex]).toContain("'system'");
    expect(statements[eventIndex]).toContain("'checkout.catalog_unavailable'");
    expect(statements[eventIndex]).toContain("where not exists");
    expect(statements[eventIndex]).not.toContain("cart_items");

    const eventValues = query.mock.calls[eventIndex][1];
    expect(eventValues?.[0]).toBe(orderId);
    expect(JSON.parse(String(eventValues?.[1]))).toEqual({
      reason: "missing_checkout_line_item_price",
      source: "stripe_checkout_session"
    });
    expect(disposition).toEqual({
      cartId: ids.cart,
      cartStatus: "active",
      orderRetired: true
    });
  });

  it("does not record a catalog event for an ineligible order", async () => {
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await new CheckoutRepository(pool).markCatalogUnavailable(
      "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
    );

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("insert into order_events"),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("abandons a stale checkout cart when an active replacement exists", async () => {
    const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
    const { pool, query } = createPool((sql) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from orders o")) {
        return {
          rows: [{
            cart_id: ids.cart,
            payment_status: "failed",
            status: "pending_payment"
          }]
        };
      }
      if (sql.includes("from carts") && sql.includes("cart_recoverable")) {
        return {
          rows: [{
            authenticated_user_id: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
            cart_recoverable: true,
            guest_token_hash: null,
            status: "checkout_started",
            user_id: "user_clerk_123"
          }]
        };
      }
      if (sql.includes("from carts sibling")) {
        return { rows: [{ id: "7ad85754-c339-4214-af6e-519eabc38501" }] };
      }
      return { rows: [] };
    });

    const disposition = await new CheckoutRepository(pool).markCatalogUnavailable(
      orderId,
    );

    expect(disposition).toEqual({
      cartId: ids.cart,
      cartStatus: "abandoned",
      orderRetired: true
    });
    expect(
      query.mock.calls.some(([sql, values]) =>
        String(sql).includes("update carts") && values?.[1] === "abandoned",
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("with released as"),
      ),
    ).toBe(true);
  });
});
