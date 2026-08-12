import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import type { CartItemInput } from "./types.js";

loadBackendEnvironment();

const databaseTestsEnabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDescribe = databaseTestsEnabled ? describe : describe.skip;
const testRunId = randomUUID();
const cartId = randomUUID();
const sessionId = `integration_${randomUUID()}_${randomUUID()}`;

type CatalogRow = {
  currency: string;
  kind: string;
  listing_customization_set_id: string;
  listing_id: string;
  listing_price_variant_id: string;
  requires_image: boolean;
  requires_text: boolean;
  requires_trim: boolean;
  variant_trim_option_id: string | null;
};

integrationDescribe("guest cart database lifecycle", () => {
  let pool: Pool;
  let service: InstanceType<typeof import("./service.js").CartService>;
  let fabricId: string;
  let initialReservedQuantity: number;

  beforeAll(async () => {
    const [{ createDatabasePool }, { CartService }] = await Promise.all([
      import("../../database/client.js"),
      import("./service.js"),
    ]);
    pool = createDatabasePool();

    const cache = new Map<string, string>();
    const redis = {
      async get(key: string) {
        return cache.get(key) ?? null;
      },
      async setEx(key: string, _ttl: number, value: string) {
        cache.set(key, value);
        return "OK";
      },
    } as unknown as RedisClientType;

    service = new CartService(pool, redis, { warn() {} });
    await pool.query(
      `
        insert into carts (id, guest_token_hash, status, currency, expires_at)
        values ($1, $2, 'active', 'usd', now() + interval '1 hour')
      `,
      [cartId, createHash("sha256").update(sessionId).digest("hex")],
    );
  });

  afterAll(async () => {
    if (!pool) return;

    await pool.query(
      `
        with released as (
          delete from fabric_reservations
          where cart_id = $1
          returning fabric_id, quantity, status
        ), totals as (
          select fabric_id, sum(quantity)::integer as quantity
          from released
          where status = 'active'
          group by fabric_id
        )
        update fabrics f
        set quantity_reserved = greatest(0, f.quantity_reserved - totals.quantity)
        from totals
        where f.id = totals.fabric_id
      `,
      [cartId],
    );
    await pool.query("delete from carts where id = $1", [cartId]);
    await pool.query("delete from assets where metadata ->> 'testRunId' = $1", [
      testRunId,
    ]);
    await pool.end();
  });

  it(
    "adds every customization level, updates quantity, and deletes without metadata loss",
    async () => {
      const catalog = await pool.query<CatalogRow>(
        `
          select
            l.id as listing_id,
            l.currency,
            lcs.id as listing_customization_set_id,
            cs.kind,
            cs.requires_text,
            cs.requires_image,
            cs.requires_trim,
            lpv.id as listing_price_variant_id,
            lpv.trim_option_id as variant_trim_option_id
          from listings l
          join listing_customization_sets lcs
            on lcs.listing_id = l.id and lcs.enabled = true
          join customization_sets cs on cs.id = lcs.customization_set_id
          join listing_price_variants lpv
            on lpv.listing_id = l.id
            and lpv.listing_customization_set_id = lcs.id
            and lpv.active = true
            and lpv.replaced_at is null
          where l.slug = 'local-seed-classic-graduation-stole'
            and l.status = 'active'
          order by cs.kind, lpv.created_at
        `,
      );
      expect(new Set(catalog.rows.map((row) => row.kind))).toEqual(
        new Set([
          "blank",
          "text_short",
          "text_long",
          "text_image",
          "text_image_trim",
        ]),
      );

      const listingId = catalog.rows[0].listing_id;
      const fabric = await pool.query<{
        id: string;
        quantity_reserved: number;
      }>(
        `
          select f.id, f.quantity_reserved
          from listing_fabrics lf
          join fabrics f on f.id = lf.fabric_id
          where lf.listing_id = $1 and lf.active = true and f.status = 'active'
          order by lf.is_default desc, lf.sort_order, f.id
          limit 1
        `,
        [listingId],
      );
      fabricId = fabric.rows[0].id;
      initialReservedQuantity = fabric.rows[0].quantity_reserved;

      const itemIds = new Map<string, string>();
      const inputs = new Map<string, CartItemInput>();
      const assetIds = new Map<string, string>();
      const uniquePackages = [
        ...new Map(
          catalog.rows.map((row) => [row.listing_customization_set_id, row]),
        ).values(),
      ];

      for (const customization of uniquePackages) {
        const font = customization.requires_text
          ? await pool.query<{ id: string }>(
              `
                select fo.id
                from listing_customization_fonts lcf
                join font_options fo on fo.id = lcf.font_option_id and fo.active = true
                where lcf.listing_customization_set_id = $1
                order by fo.name
                limit 1
              `,
              [customization.listing_customization_set_id],
            )
          : null;
        const trim = customization.requires_trim
          ? await pool.query<{ id: string }>(
              `
                select tr.id
                from listing_customization_trims lct
                join trim_options tr on tr.id = lct.trim_option_id and tr.active = true
                where lct.listing_customization_set_id = $1
                order by tr.name
                limit 1
              `,
              [customization.listing_customization_set_id],
            )
          : null;
        const trimOptionId = trim?.rows[0]?.id ?? null;
        const packageVariants = catalog.rows.filter(
          (row) =>
            row.listing_customization_set_id ===
            customization.listing_customization_set_id,
        );
        const variant =
          packageVariants.find(
            (row) => row.variant_trim_option_id === trimOptionId,
          ) ?? packageVariants.find((row) => row.variant_trim_option_id === null);
        expect(variant).toBeDefined();

        let imageAssetId: string | null = null;
        if (customization.requires_image) {
          imageAssetId = randomUUID();
          assetIds.set(customization.kind, imageAssetId);
          await pool.query(
            `
              insert into assets (
                id, provider, storage_key, url, content_type, byte_size,
                visibility, context, status, cart_id, listing_id,
                listing_customization_set_id, metadata
              ) values (
                $1, 'integration_test', $2, $3, 'image/png', 1024,
                'private', 'customization_image', 'uploaded', $4, $5, $6, $7::jsonb
              )
            `,
            [
              imageAssetId,
              `integration/${testRunId}/${imageAssetId}.png`,
              `https://example.test/${imageAssetId}.png`,
              cartId,
              listingId,
              customization.listing_customization_set_id,
              JSON.stringify({ testRunId }),
            ],
          );
        }

        const input: CartItemInput = {
          fabricId,
          fontOptionId: font?.rows[0]?.id ?? null,
          imageAssetId,
          line1: customization.requires_text ? `Class of 2027 ${customization.kind}` : "",
          line2: "",
          listingCustomizationSetId: customization.listing_customization_set_id,
          listingId,
          listingPriceVariantId: variant!.listing_price_variant_id,
          quantity: 1,
          trimOptionId,
        };
        const result = await service.addGuestItem({ cartId, sessionId }, input);
        expect(result.cartItemId).toBeDefined();
        itemIds.set(customization.kind, result.cartItemId!);
        inputs.set(customization.kind, input);
      }

      const stored = await pool.query<{
        customization_asset_id: string | null;
        customization_payload: CartItemInput;
        kind: string;
        quantity: number;
      }>(
        `
          select
            cs.kind,
            ci.quantity,
            ci.customization_payload,
            ci.customization_asset_id
          from cart_items ci
          join listing_customization_sets lcs on lcs.id = ci.listing_customization_set_id
          join customization_sets cs on cs.id = lcs.customization_set_id
          where ci.cart_id = $1
          order by cs.kind
        `,
        [cartId],
      );
      expect(stored.rows).toHaveLength(5);
      for (const row of stored.rows) {
        const expected = inputs.get(row.kind)!;
        expect(row.customization_payload).toEqual({
          fontOptionId: expected.fontOptionId,
          imageAssetId: expected.imageAssetId,
          line1: expected.line1,
          line2: expected.line2,
          trimOptionId: expected.trimOptionId,
        });
        expect(row.customization_asset_id).toBe(expected.imageAssetId);
      }

      const longInput = inputs.get("text_long")!;
      await service.updateGuestItem(
        { cartId, sessionId },
        itemIds.get("text_long")!,
        {
          ...longInput,
          line1: "Class of 2027 with distinction",
          quantity: 2,
        },
      );
      const updated = await pool.query<{
        customization_payload: { line1: string };
        quantity: number;
      }>("select quantity, customization_payload from cart_items where id = $1", [
        itemIds.get("text_long"),
      ]);
      expect(updated.rows[0]).toMatchObject({
        customization_payload: { line1: "Class of 2027 with distinction" },
        quantity: 2,
      });

      await service.removeGuestItem(
        { cartId, sessionId },
        itemIds.get("text_image_trim")!,
      );
      expect(
        await pool.query("select id from cart_items where id = $1", [
          itemIds.get("text_image_trim"),
        ]),
      ).toMatchObject({ rows: [] });
      const releasedAsset = await pool.query<{ status: string }>(
        "select status from assets where id = $1",
        [assetIds.get("text_image_trim")],
      );
      expect(releasedAsset.rows[0].status).toBe("uploaded");

      for (const [kind, itemId] of itemIds) {
        if (kind !== "text_image_trim") {
          await service.removeGuestItem({ cartId, sessionId }, itemId);
        }
      }
      const finalCart = await service.getGuestCart({ cartId, sessionId });
      expect(finalCart).toMatchObject({ items: [], subtotalCents: 0 });
      const finalFabric = await pool.query<{ quantity_reserved: number }>(
        "select quantity_reserved from fabrics where id = $1",
        [fabricId],
      );
      expect(finalFabric.rows[0].quantity_reserved).toBe(initialReservedQuantity);
    },
    30_000,
  );
});
