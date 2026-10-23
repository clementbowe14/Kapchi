import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
  let initialActiveReservedQuantity: number;
  let initialStoredReservedQuantity: number;

  beforeAll(async () => {
    const [{ createDatabasePool }, { CartService }] = await Promise.all([
      import("../../database/client.js"),
      import("./service.js"),
    ]);
    pool = createDatabasePool();

    service = new CartService(pool);
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
        counted_reserved_quantity: number;
        id: string;
        quantity_reserved: number;
      }>(
        `
          select
            f.id,
            f.quantity_reserved,
            availability.counted_reserved_quantity
          from listing_fabrics lf
          join fabrics f on f.id = lf.fabric_id
          join fabric_inventory_availability availability on availability.id = f.id
          where lf.listing_id = $1 and lf.active = true and f.status = 'active'
          order by lf.is_default desc, lf.sort_order, f.id
          limit 1
        `,
        [listingId],
      );
      fabricId = fabric.rows[0].id;
      initialActiveReservedQuantity = fabric.rows[0].counted_reserved_quantity;
      initialStoredReservedQuantity = fabric.rows[0].quantity_reserved;

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
          priorityCode: "standard",
          quantity: 1,
          trimOptionId,
        };
        const idempotencyKey = `integration-add-${customization.kind}`;
        const attempts =
          customization.kind === "blank"
            ? await Promise.all([
                service.addGuestItem(
                  { cartId, sessionId },
                  input,
                  idempotencyKey,
                ),
                service.addGuestItem(
                  { cartId, sessionId },
                  input,
                  idempotencyKey,
                ),
              ])
            : [
                await service.addGuestItem(
                  { cartId, sessionId },
                  input,
                  idempotencyKey,
                )
              ];
        const result = attempts[0];
        expect(result.cartItemId).toBeDefined();
        expect(new Set(attempts.map((attempt) => attempt.cartItemId))).toEqual(
          new Set([result.cartItemId]),
        );
        expect(new Set(attempts.map((attempt) => attempt.revision))).toEqual(
          new Set([result.revision]),
        );
        itemIds.set(customization.kind, result.cartItemId!);
        inputs.set(customization.kind, input);

        if (customization.kind === "blank") {
          await expect(
            service.addGuestItem(
              { cartId, sessionId },
              { ...input, quantity: 2 },
              idempotencyKey,
            ),
          ).rejects.toMatchObject({ name: "CartIdempotencyConflictError" });
        }
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
      await expect(
        service.getGuestCart({ cartId, sessionId }),
      ).resolves.toMatchObject({
        lineItemCount: 5,
        revision: 5,
        totalQuantity: 5
      });
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
      const updatedView = await service.updateGuestItem(
        { cartId, sessionId },
        itemIds.get("text_long")!,
        {
          ...longInput,
          line1: "Class of 2027 with distinction",
          quantity: 2,
        },
      );
      expect(updatedView).toMatchObject({
        lineItemCount: 5,
        revision: 6,
        totalQuantity: 6
      });
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

      const removedView = await service.removeGuestItem(
        { cartId, sessionId },
        itemIds.get("text_image_trim")!,
      );
      expect(removedView).toMatchObject({
        lineItemCount: 4,
        revision: 7,
        totalQuantity: 5
      });
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
      expect(finalCart).toMatchObject({
        items: [],
        lineItemCount: 0,
        revision: 11,
        subtotalCents: 0,
        totalQuantity: 0
      });
      const finalFabric = await pool.query<{
        counted_reserved_quantity: number;
        quantity_reserved: number;
      }>(
        `
          select
            f.quantity_reserved,
            availability.counted_reserved_quantity
          from fabrics f
          join fabric_inventory_availability availability on availability.id = f.id
          where f.id = $1
        `,
        [fabricId],
      );
      expect(finalFabric.rows[0].quantity_reserved).toBe(
        initialStoredReservedQuantity,
      );
      expect(finalFabric.rows[0].counted_reserved_quantity).toBe(
        initialActiveReservedQuantity,
      );
    },
    30_000,
  );

  it("keeps cart fields and quantities in one repeatable-read snapshot", async () => {
    const snapshotCartId = randomUUID();
    const snapshotItemId = randomUUID();
    const snapshotSessionId = `snapshot_${randomUUID()}_${randomUUID()}`;
    const catalog = await pool.query<{
      listing_customization_set_id: string;
      listing_id: string;
      listing_price_variant_id: string;
      unit_amount_cents: number;
    }>(
      `
        select
          l.id as listing_id,
          lcs.id as listing_customization_set_id,
          lpv.id as listing_price_variant_id,
          lpv.unit_amount_cents
        from listings l
        join listing_customization_sets lcs
          on lcs.listing_id = l.id and lcs.enabled = true
        join listing_price_variants lpv
          on lpv.listing_id = l.id
          and lpv.listing_customization_set_id = lcs.id
          and lpv.active = true
          and lpv.replaced_at is null
        where l.status = 'active'
        order by l.id, lcs.id, lpv.id
        limit 1
      `,
    );
    const selection = catalog.rows[0];
    expect(selection).toBeDefined();

    await pool.query(
      `
        insert into carts (
          id, guest_token_hash, status, currency, subtotal_cents, expires_at
        ) values ($1, $2, 'active', 'usd', $3, now() + interval '1 hour')
      `,
      [
        snapshotCartId,
        createHash("sha256").update(snapshotSessionId).digest("hex"),
        selection.unit_amount_cents
      ],
    );
    await pool.query(
      `
        insert into cart_items (
          id, cart_id, listing_id, listing_customization_set_id,
          listing_price_variant_id, quantity, unit_amount_cents, currency,
          customization_payload, validation_status
        ) values ($1, $2, $3, $4, $5, 1, $6, 'usd', '{}'::jsonb, 'valid')
      `,
      [
        snapshotItemId,
        snapshotCartId,
        selection.listing_id,
        selection.listing_customization_set_id,
        selection.listing_price_variant_id,
        selection.unit_amount_cents
      ],
    );

    let signalShellRead!: () => void;
    let continueProjection!: () => void;
    const shellRead = new Promise<void>((resolve) => {
      signalShellRead = resolve;
    });
    const projectionGate = new Promise<void>((resolve) => {
      continueProjection = resolve;
    });
    let paused = false;
    const snapshotPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          async query(text: string, values: unknown[] = []) {
            const result = await client.query(text, values);
            if (
              !paused &&
              text.includes("from carts") &&
              text.includes("guest_token_hash") &&
              !text.includes("for update")
            ) {
              paused = true;
              signalShellRead();
              await projectionGate;
            }
            return result;
          },
          release() {
            client.release();
          }
        } as unknown as PoolClient;
      },
      query: pool.query.bind(pool)
    } as unknown as Pool;
    const { CartService } = await import("./service.js");
    const snapshotService = new CartService(snapshotPool);
    const readPromise = snapshotService.getGuestCart({
      cartId: snapshotCartId,
      sessionId: snapshotSessionId
    });

    try {
      await shellRead;
      const writer = await pool.connect();
      try {
        await writer.query("begin");
        await writer.query("update cart_items set quantity = 2 where id = $1", [
          snapshotItemId
        ]);
        await writer.query(
          `
            update carts
            set subtotal_cents = $2, revision = revision + 1
            where id = $1
          `,
          [snapshotCartId, selection.unit_amount_cents * 2],
        );
        await writer.query("commit");
      } catch (error) {
        await writer.query("rollback");
        throw error;
      } finally {
        writer.release();
      }
      continueProjection();

      await expect(readPromise).resolves.toMatchObject({
        lineItemCount: 1,
        revision: 0,
        subtotalCents: selection.unit_amount_cents,
        totalQuantity: 1
      });
      await expect(
        service.getGuestCart({
          cartId: snapshotCartId,
          sessionId: snapshotSessionId
        }),
      ).resolves.toMatchObject({
        lineItemCount: 1,
        revision: 1,
        subtotalCents: selection.unit_amount_cents * 2,
        totalQuantity: 2
      });
    } finally {
      continueProjection();
      await pool.query("delete from carts where id = $1", [snapshotCartId]);
    }
  });
});
