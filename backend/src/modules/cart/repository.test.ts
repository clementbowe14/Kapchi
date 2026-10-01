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
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const [{ MAX_CART_SUBTOTAL_CENTS }, { CartRepository }] = await Promise.all([
  import("./guest-session.js"),
  import("./repository.js")
]);

const ids = {
  asset: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  cart: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  variant: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};

const input = {
  fabricId: null,
  fontOptionId: null,
  imageAssetId: ids.asset,
  line1: "Class of 2027",
  line2: "Kapchi University",
  listingCustomizationSetId: ids.customizationSet,
  listingId: ids.listing,
  listingPriceVariantId: ids.variant,
  priorityCode: "standard",
  quantity: 1,
  trimOptionId: null
};

const cart = {
  id: ids.cart,
  currency: "usd",
  expires_at: "2027-08-01T12:00:00.000Z",
  revision: 4,
  subtotal_cents: 0
};

function repository() {
  const pool = { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
  return new CartRepository(pool);
}

describe("CartRepository asset ownership", () => {
  it("locks the validated asset and conditionally attaches the same owner state", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ rows: [{ id: ids.asset }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000093",
            label: "Standard",
            maximum_business_days: 7,
            minimum_business_days: 5,
            priority_code: "standard",
            revision: 1
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: ids.asset }] });
    const client = { query } as unknown as PoolClient;
    const subject = repository();

    await subject.validateSelection(client, cart, input);
    await subject.attachAsset(client, ids.cart, input);

    expect(String(query.mock.calls[1][0])).toContain("for update of a");
    expect(String(query.mock.calls[3][0])).toContain(
      "status in ('uploaded', 'attached')",
    );
    expect(String(query.mock.calls[3][0])).toContain("returning id");
    expect(query.mock.calls[3][1]).toEqual([
      ids.asset,
      ids.cart,
      ids.listing,
      ids.customizationSet
    ]);
  });

  it("rejects an attachment update unless exactly one expected asset row changes", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    } as unknown as PoolClient;

    await expect(repository().attachAsset(client, ids.cart, input)).rejects.toMatchObject(
      {
        message: "The selected customization image is no longer available.",
        name: "CartConflictError"
      },
    );
  });

  it("returns a specific error when the selected production priority is unavailable", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          currency: "usd",
          customization_enabled: true,
          listing_status: "active",
          max_chars: 120,
          min_chars: 0,
          price_variant_active: true,
          requires_fabric: false,
          requires_image: true,
          requires_text: true,
          requires_trim: false,
          unit_amount_cents: 8500,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: ids.asset }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await expect(repository().validateSelection(client, cart, input)).rejects.toMatchObject({
      name: "InvalidProductionPriorityError",
    });
    expect(String(query.mock.calls[2][0])).toContain(
      "from listing_production_estimate_rules",
    );
  });

  it("preserves a valid snapshot without consulting a newer rule revision", async () => {
    const snapshot = {
      maximumBusinessDays: 7,
      minimumBusinessDays: 5,
      priorityCode: "standard",
      priorityLabel: "Standard",
      quotedAt: "2026-10-01T16:00:00.000Z",
      ruleId: "00000000-0000-4000-8000-000000000093",
      ruleRevision: 1,
      schemaVersion: 1 as const,
    };
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        currency: "usd",
        customization_enabled: true,
        listing_status: "active",
        max_chars: 120,
        min_chars: 0,
        price_variant_active: true,
        requires_fabric: false,
        requires_image: false,
        requires_text: true,
        requires_trim: false,
        unit_amount_cents: 8500,
      }],
    });
    const client = { query } as unknown as PoolClient;

    const selection = await repository().validateSelection(
      client,
      cart,
      { ...input, imageAssetId: null },
      "cart-item-1",
      snapshot,
    );

    expect(selection.productionEstimateSnapshot).toEqual(snapshot);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("CartRepository subtotal bounds", () => {
  it("writes the PostgreSQL integer boundary after a bigint-safe calculation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ subtotal_cents: String(MAX_CART_SUBTOTAL_CENTS) }]
      })
      .mockResolvedValueOnce({
        rows: [{ revision: 5, subtotal_cents: MAX_CART_SUBTOTAL_CENTS }]
      })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await repository().finishMutation(client, cart);

    expect(String(query.mock.calls[0][0])).toContain("ci.quantity::bigint");
    expect(query.mock.calls[1][1]).toEqual([ids.cart, MAX_CART_SUBTOTAL_CENTS]);
    expect(result.subtotalCents).toBe(MAX_CART_SUBTOTAL_CENTS);
    expect(result.revision).toBe(5);
    expect(result).toMatchObject({ lineItemCount: 0, totalQuantity: 0 });
    expect(String(query.mock.calls[1][0])).toContain("revision = revision + 1");
  });

  it("rejects overflow before issuing the subtotal update", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ subtotal_cents: String(MAX_CART_SUBTOTAL_CENTS + 1) }]
    });
    const client = { query } as unknown as PoolClient;

    await expect(repository().finishMutation(client, cart)).rejects.toMatchObject({
      message: "Cart total exceeds the supported maximum.",
      name: "CartConflictError"
    });

    expect(query).toHaveBeenCalledOnce();
  });
});
