import { describe, expect, it, vi } from "vitest";
import { AdminAssetRepository } from "./repository.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";

describe("admin private asset repository", () => {
  it("scopes the item to its order and returns provider-neutral metadata", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({
      rows: [{
        asset_byte_size: 128,
        asset_checksum: "etag-safe",
        asset_content_type: "image/png",
        asset_context: "customization_image",
        asset_expected_pathname: `kapchi/customization_image/${assetId}/crest.png`,
        asset_id: assetId,
        asset_original_filename: "crest.png",
        asset_provider: "vercel_blob",
        asset_status: "attached",
        asset_storage_key: `kapchi/customization_image/${assetId}/crest.png`,
        asset_visibility: "private",
        canonical_asset_id: assetId,
        item_id: orderItemId,
        order_id: orderId,
        paid_at: new Date("2026-10-26T12:00:00.000Z"),
        snapshot_asset_id: assetId
      }]
    }));
    const repository = new AdminAssetRepository({ query } as never);

    await expect(repository.lookup(orderId, orderItemId)).resolves.toMatchObject({
      asset: { id: assetId, provider: "vercel_blob" },
      canonicalAssetId: assetId,
      orderId,
      orderItemId
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "order_items.order_id = orders.id",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([orderId, orderItemId]);
  });

  it("distinguishes missing orders from foreign or missing order items", async () => {
    const query = vi.fn<
      (...args: unknown[]) => Promise<{ rows: unknown[] }>
    >();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ order_id: orderId, item_id: null }] });
    const repository = new AdminAssetRepository({ query } as never);

    await expect(repository.lookup(orderId, orderItemId)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      statusCode: 404
    });
    await expect(repository.lookup(orderId, orderItemId)).rejects.toMatchObject({
      code: "ORDER_ITEM_NOT_FOUND",
      statusCode: 404
    });
  });

  it("resolves only an active local Clerk-backed actor", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ id: assetId }] }));
    const repository = new AdminAssetRepository({ query } as never);

    await expect(repository.findActor("user_admin")).resolves.toEqual({
      authSubject: "user_admin",
      userId: assetId
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("disabled_at is null");
  });

  it("writes only safe identifiers and outcome codes to the access ledger", async () => {
    const auditId = "44444444-4444-4444-8444-444444444444";
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ id: auditId }] }));
    const repository = new AdminAssetRepository({ query } as never);

    await expect(repository.recordAccess({
      actor: { authSubject: "user_admin", userId: assetId },
      assetId,
      deliveryStatus: "streaming",
      disposition: "inline",
      orderId,
      orderItemId,
      outcome: "opened",
      reasonCode: null,
      requestId: "request-1"
    })).resolves.toBe(auditId);

    const serialized = JSON.stringify(query.mock.calls[0]);
    expect(serialized).not.toContain("filename");
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("token");
  });
});
