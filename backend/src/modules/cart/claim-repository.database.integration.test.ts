import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";

loadBackendEnvironment();

const databaseTestsEnabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDescribe = databaseTestsEnabled ? describe : describe.skip;

integrationDescribe("authenticated cart claim database consistency", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns canonical counts and increments revision exactly once", async () => {
    const cartId = randomUUID();
    const cartItemId = randomUUID();
    const authSubject = `claim_integration_${randomUUID()}`;
    const sessionId = `claim_${randomUUID()}_${randomUUID()}`;
    const email = `${randomUUID()}@example.test`;
    const selectionResult = await pool.query<{
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
    const selection = selectionResult.rows[0];
    expect(selection).toBeDefined();

    try {
      await pool.query(
        `
          insert into carts (
            id, guest_token_hash, status, currency, subtotal_cents, expires_at
          ) values ($1, $2, 'active', 'usd', $3, now() + interval '1 hour')
        `,
        [
          cartId,
          createHash("sha256").update(sessionId).digest("hex"),
          selection.unit_amount_cents * 3
        ],
      );
      await pool.query(
        `
          insert into cart_items (
            id, cart_id, listing_id, listing_customization_set_id,
            listing_price_variant_id, quantity, unit_amount_cents, currency,
            customization_payload, validation_status
          ) values ($1, $2, $3, $4, $5, 3, $6, 'usd', '{}'::jsonb, 'valid')
        `,
        [
          cartItemId,
          cartId,
          selection.listing_id,
          selection.listing_customization_set_id,
          selection.listing_price_variant_id,
          selection.unit_amount_cents
        ],
      );

      const { CartClaimRepository } = await import("./claim-repository.js");
      const repository = new CartClaimRepository(pool);
      const identity = {
        authSubject,
        avatarUrl: null,
        displayName: "Integration Customer",
        email,
        phone: null
      };
      const claimed = await repository.claim(identity, { cartId, sessionId });

      expect(claimed).toMatchObject({
        cartId,
        lineItemCount: 1,
        revision: 1,
        subtotalCents: selection.unit_amount_cents * 3,
        totalQuantity: 3,
        warnings: []
      });
      const repeated = await repository.claim(identity, null);
      expect(repeated).toMatchObject({
        cartId,
        lineItemCount: 1,
        revision: 1,
        totalQuantity: 3
      });
      const { CartService } = await import("./service.js");
      await expect(
        new CartService(pool).getAuthenticatedCartSummary(authSubject),
      ).resolves.toEqual({
        cartId,
        lineItemCount: 1,
        revision: 1,
        totalQuantity: 3
      });
      await expect(
        pool.query<{ revision: number }>(
          "select revision from carts where id = $1",
          [cartId],
        ),
      ).resolves.toMatchObject({ rows: [{ revision: 1 }] });
    } finally {
      await pool.query("delete from carts where id = $1", [cartId]);
      await pool.query(
        `
          delete from customers
          where user_id in (
            select id from users
            where auth_provider = 'clerk' and auth_subject = $1
          )
        `,
        [authSubject],
      );
      await pool.query(
        "delete from users where auth_provider = 'clerk' and auth_subject = $1",
        [authSubject],
      );
    }
  });
});
