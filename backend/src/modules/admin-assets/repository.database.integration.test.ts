import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { AdminAssetRepository } from "./repository.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

integrationDescribe("admin private asset repository database", () => {
  let pool: Pool;
  let repository: AdminAssetRepository;
  const userId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const assetId = randomUUID();
  const authSubject = `private-asset-admin-${userId}`;
  const storageKey = `kapchi/customization_image/${assetId}/crest.png`;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminAssetRepository(pool);
    await pool.query(
      `insert into users (id, auth_provider, auth_subject)
       values ($1, 'clerk', $2)`,
      [userId, authSubject],
    );
    await pool.query(
      `insert into assets (
         id, provider, storage_key, url, content_type, byte_size, checksum,
         visibility, context, status, metadata
       ) values (
         $1, 'vercel_blob', $2, 'https://example.invalid/private', 'image/png',
         68, 'etag-test', 'private', 'customization_image', 'attached', $3::jsonb
       )`,
      [
        assetId,
        storageKey,
        JSON.stringify({ expectedPathname: storageKey, originalFilename: "crest.png" })
      ],
    );
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status,
         subtotal_cents, total_cents, currency, paid_at
       ) values ($1, $2, 'paid', 'paid', 'queued', 5000, 5000, 'usd', now())`,
      [orderId, `PRIVATE-ASSET-${orderId}`],
    );
    await pool.query(
      `insert into order_items (
         id, order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, customization_snapshot, customization_asset_id
       ) values ($1, $2, 1, 5000, 5000, 'usd', '{}'::jsonb, $3::jsonb, $4)`,
      [orderItemId, orderId, JSON.stringify({ imageAssetId: assetId }), assetId],
    );
  });

  afterAll(async () => {
    await pool?.query(
      "delete from admin_private_asset_access_events where actor_user_id = $1",
      [userId],
    );
    await pool?.query("delete from order_items where id = $1", [orderItemId]);
    await pool?.query("delete from orders where id = $1", [orderId]);
    await pool?.query("delete from assets where id = $1", [assetId]);
    await pool?.query("delete from users where id = $1", [userId]);
    await pool?.end();
  });

  it("resolves the purchased item and persists its verified access actor", async () => {
    await expect(repository.lookup(orderId, orderItemId)).resolves.toMatchObject({
      asset: { id: assetId, storageKey },
      canonicalAssetId: assetId,
      snapshotAssetId: assetId
    });
    const actor = await repository.findActor(authSubject);
    expect(actor).toEqual({ authSubject, userId });

    const eventId = await repository.recordAccess({
      actor: actor!,
      assetId,
      deliveryStatus: "streaming",
      disposition: "inline",
      orderId,
      orderItemId,
      outcome: "opened",
      reasonCode: null,
      requestId: `request-${randomUUID()}`
    });
    await repository.updateDelivery(eventId, "completed", 68);
    const event = await pool.query(
      `select actor_user_id, delivery_status, bytes_sent
       from admin_private_asset_access_events where id = $1`,
      [eventId],
    );
    expect(event.rows[0]).toMatchObject({
      actor_user_id: userId,
      bytes_sent: 68,
      delivery_status: "completed"
    });
  });

  it("prevents hard deletion of artwork referenced by an order item", async () => {
    await expect(pool.query("delete from assets where id = $1", [assetId]))
      .rejects.toMatchObject({ code: "23503" });
  });
});
