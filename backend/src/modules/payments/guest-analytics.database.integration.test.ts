import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";

loadBackendEnvironment();

const integrationDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const cookieName = "kapchi_guest_analytics";

integrationDescribe("guest checkout attribution", () => {
  const listingId = randomUUID();
  const fabricId = randomUUID();
  const setId = randomUUID();
  const variantId = randomUUID();
  const policyFixtureSchema = `guest_checkout_${randomBytes(8).toString("hex")}`;
  const cartIds: string[] = [];
  const apps: FastifyInstance[] = [];
  let pool: Pool;

  beforeAll(async () => {
    const { config } = await import("../../config/index.js");
    const { createDatabasePoolFromConfig } = await import("../../database/pool-factory.js");
    const url = new URL(config.database.url);
    url.searchParams.set("options", `-c search_path=${policyFixtureSchema},public`);
    pool = createDatabasePoolFromConfig({ database: { ...config.database, url: url.toString() } });
    // Isolate append-only checkout evidence so cleanup never touches the real assertions table.
    await pool.query(`create schema ${policyFixtureSchema}`);
    await pool.query(`create table ${policyFixtureSchema}.order_policy_assertions
      (like public.order_policy_assertions including all,
       foreign key (order_id) references public.orders(id) on delete restrict)`);
    await pool.query(
      `insert into listings (id, slug, title, status, base_price_cents, requires_fabric)
       values ($1, $2, 'Guest attribution fixture', 'active', 1000, true)`,
      [listingId, `guest-attribution-${listingId}`],
    );
    await pool.query("insert into fabrics (id, name, quantity_on_hand) values ($1, 'Test Stole Fabric', 100)", [fabricId]);
    await pool.query("insert into listing_fabrics (listing_id, fabric_id) values ($1, $2)", [listingId, fabricId]);
    await pool.query(
      `insert into listing_customization_sets (id, listing_id, customization_set_id)
       select $1, $2, id from customization_sets where kind = 'blank'`,
      [setId, listingId],
    );
    await pool.query(
      `insert into listing_price_variants (
         id, listing_id, listing_customization_set_id, variant_key,
         unit_amount_cents, stripe_product_id, stripe_price_id
       ) values ($1, $2, $3, 'blank', 1000, $4, $5)`,
      [variantId, listingId, setId, `prod_guest_${variantId}`, `price_guest_${variantId}`],
    );
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (cartIds.length > 0) {
      await pool.query(`truncate ${policyFixtureSchema}.order_policy_assertions`);
      await pool.query("delete from fabric_reservations where cart_id = any($1::uuid[])", [cartIds]);
      await pool.query("delete from orders where cart_id = any($1::uuid[])", [cartIds]);
      await pool.query("delete from carts where id = any($1::uuid[])", [cartIds]);
      cartIds.length = 0;
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query("delete from listings where id = $1", [listingId]);
      await pool.query("delete from fabrics where id = $1", [fabricId]);
    } finally {
      try {
        await pool.query(`drop table if exists ${policyFixtureSchema}.order_policy_assertions`);
        await pool.query(`drop schema if exists ${policyFixtureSchema}`);
      } finally {
        await pool.end();
      }
    }
  });

  async function cart() {
    const { hashSessionId } = await import("../cart/guest-session.js");
    const id = randomUUID();
    const itemId = randomUUID();
    const session = randomBytes(32).toString("base64url");
    cartIds.push(id);
    await pool.query(
      `insert into carts (id, guest_token_hash, subtotal_cents, expires_at)
       values ($1, $2, 1000, now() + interval '1 hour')`,
      [id, hashSessionId(session)],
    );
    await pool.query(
      `insert into cart_items (
         id, cart_id, listing_id, listing_customization_set_id, listing_price_variant_id, fabric_id,
         quantity, unit_amount_cents, customization_payload, production_priority_code,
         production_estimate_snapshot
       ) values ($1, $2, $3, $4, $5, $6, 1, 1000, $7, 'standard', $8)`,
      [itemId, id, listingId, setId, variantId, fabricId,
        JSON.stringify({ fontOptionId: null, imageAssetId: null, line1: "", line2: "", trimOptionId: null }),
        JSON.stringify({
          maximumBusinessDays: 5, minimumBusinessDays: 2, priorityCode: "standard",
          priorityLabel: "Standard", quotedAt: "2026-01-01T00:00:00.000Z",
          ruleId: randomUUID(), ruleRevision: 1, schemaVersion: 1
        })],
    );
    await pool.query(
      `insert into fabric_reservations (fabric_id, cart_id, cart_item_id, quantity, expires_at)
       values ($1, $2, $3, 1, now() + interval '1 hour')`,
      [fabricId, id, itemId],
    );
    return { id, session };
  }

  async function server(enabled = true) {
    const { authPlugin } = await import("../auth/index.js");
    const { activePolicyBundle } = await import("../policies/policy-contract.js");
    const { createPaymentsPlugin } = await import("./plugin.js");
    const app = fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", pool);
    let failNext = false;
    const expired = new Set<string>();
    const session = (id: string) => ({
      customerId: null, expiresAt: new Date(Date.now() + 60 * 60_000), id,
      paymentStatus: "unpaid", status: expired.has(id) ? "expired" : "open",
      url: "https://checkout.example.test/session"
    });
    const createSession = vi.fn(async (input: { orderId: string }) => {
      if (failNext) {
        failNext = false;
        throw new Error("Synthetic provider outage");
      }
      return session(`cs_test_guest_${input.orderId.replaceAll("-", "")}`);
    });
    await app.register(createPaymentsPlugin({
      checkoutProviderFactory: () => ({ createSession, retrieveSession: async (id) => session(id) }),
      paymentConfig: {
        checkout: {
          cancelUrl: "https://example.test/cart", successUrl: "https://example.test/confirmation",
          ...(enabled ? { guestAnalyticsCookieSecret: "g".repeat(40) } : {})
        },
        stripe: { webhookSecret: "test-only" }
      },
      stripeClientFactory: () => ({ checkout: { sessions: {} }, webhooks: {} }) as never
    }), { prefix: "/payments" });
    return {
      app,
      createSession,
      expire: (id: string) => expired.add(id),
      failNext: () => { failNext = true; },
      checkout: (owner: Awaited<ReturnType<typeof cart>>, identity?: string, gpc = false) => app.inject({
        method: "POST", url: "/payments/checkout-sessions",
        cookies: { session_id: owner.session, ...(identity ? { [cookieName]: identity } : {}) },
        headers: gpc ? { "sec-gpc": "1" } : {},
        payload: {
          customerEmail: "same-contact@example.test", customerPhone: "+12025550100",
          preferredContactMethod: "email", policyAssertion: {
            bundleVersion: activePolicyBundle.bundleVersion, returnsAcknowledged: true, termsAgreed: true
          }
        }
      })
    };
  }

  async function orderRow(id: string) {
    const { rows } = await pool.query<{
      cart_id: string;
      guest_analytics_digest: string | null;
      status: string;
      user_id: string | null;
    }>("select cart_id, guest_analytics_digest, status, user_id from orders where id = $1", [id]);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("reuses one browser across carts without reusing cart or order authorization", async () => {
    const payments = await server();
    const firstCart = await cart();
    const first = await payments.checkout(firstCart);
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json();
    const identity = first.cookies.find(({ name }) => name === cookieName)?.value;
    expect(identity).toBeTruthy();
    const firstOrder = await orderRow(firstBody.orderId);
    expect(firstOrder).toMatchObject({ cart_id: firstCart.id, user_id: null });
    expect(firstOrder.guest_analytics_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(firstBody).sort()).toEqual([
      "checkoutSessionId", "orderId", "paymentStatus", "publicOrderNumber", "url"
    ]);
    expect(JSON.stringify(payments.createSession.mock.calls)).not.toContain(firstOrder.guest_analytics_digest);

    const secondCart = await cart();
    const second = await payments.checkout(secondCart, identity);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.cookies).toHaveLength(0);
    expect(await orderRow(second.json().orderId)).toMatchObject({
      cart_id: secondCart.id, guest_analytics_digest: firstOrder.guest_analytics_digest, user_id: null
    });
    for (const session of [undefined, secondCart.session]) {
      const status = await payments.app.inject({
        method: "GET", url: `/payments/checkout-sessions/${firstBody.checkoutSessionId}/status`,
        cookies: { [cookieName]: identity!, ...(session ? { session_id: session } : {}) }
      });
      expect(status.statusCode).toBe(404);
    }

    await pool.query(
      `update orders set status = 'paid', payment_status = 'paid',
         created_at = case when id = $1 then '2026-06-14T12:00:00Z'::timestamptz else '2026-06-15T12:00:00Z' end,
         paid_at = case when id = $1 then '2026-06-14T12:05:00Z'::timestamptz else '2026-06-15T12:05:00Z' end
       where id in ($1, $2)`,
      [firstBody.orderId, second.json().orderId],
    );
    const { SalesAnalyticsRepository } = await import("../admin-analytics/repository.js");
    const report = await new SalesAnalyticsRepository(pool).getSalesReport({
      bestSellerLimit: 10, bucket: "day", currency: "usd", startDate: "2026-06-15",
      endDate: "2026-06-15", timezone: "UTC"
    });
    expect(report.customerBreakdown).toEqual({
      newCustomerCount: 0, returningCustomerCount: 1, unidentifiedPaidOrderCount: 0
    });
  });

  it("mints at most once for concurrent attempts on the same cart", async () => {
    const payments = await server();
    const owner = await cart();
    const responses = await Promise.all([payments.checkout(owner), payments.checkout(owner)]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(201);
    expect(new Set(responses.map((response) => response.json().orderId)).size).toBe(1);
    expect(responses.flatMap(({ cookies }) => cookies).filter(({ name }) => name === cookieName)).toHaveLength(1);
  });

  it.each(["absent cookie", "matching cookie", "different cookie", "disabled initial capture"])(
    "does not mint on a retry after a provider failure with %s", async (scenario) => {
      const payments = await server();
      const firstServer = scenario === "disabled initial capture" ? await server(false) : payments;
      const seed = await payments.checkout(await cart());
      const seededCookie = seed.cookies.find(({ name }) => name === cookieName)?.value;
      expect(seededCookie).toBeTruthy();
      const owner = await cart();
      firstServer.failNext();
      const first = await firstServer.checkout(owner, scenario === "matching cookie" ? seededCookie : undefined);
      expect(first.statusCode, first.body).toBe(502);
      expect(first.cookies).toHaveLength(0);
      const [lastCall] = firstServer.createSession.mock.calls.slice(-1);
      const orderId = lastCall![0].orderId;
      const original = await orderRow(orderId);
      if (scenario === "disabled initial capture") expect(original.guest_analytics_digest).toBeNull();
      else expect(original.guest_analytics_digest).toMatch(/^[a-f0-9]{64}$/);
      const retry = await payments.checkout(owner, scenario === "absent cookie" ? undefined : seededCookie);
      expect(retry.statusCode, retry.body).toBe(201);
      expect(retry.json().orderId).toBe(orderId);
      expect(retry.cookies).toHaveLength(0);
      expect(await orderRow(orderId)).toEqual(original);
    },
  );

  it("clears opted-out cookies without reviving them and mints a new key on replacement", async () => {
    const payments = await server();
    const owner = await cart();
    const first = await payments.checkout(owner);
    expect(first.statusCode, first.body).toBe(201);
    const { checkoutSessionId, orderId } = first.json();
    const original = await orderRow(orderId);
    const identity = first.cookies.find(({ name }) => name === cookieName)?.value;
    expect(identity).toBeTruthy();
    const optedOut = await payments.checkout(owner, identity, true);
    expect(optedOut.statusCode, optedOut.body).toBe(201);
    expect(optedOut.cookies.find(({ name }) => name === cookieName)?.value).toBe("");
    const retry = await payments.checkout(owner);
    expect(retry.json().orderId).toBe(orderId);
    expect(retry.cookies).toHaveLength(0);

    payments.expire(checkoutSessionId);
    const replacement = await payments.checkout(owner);
    expect(replacement.statusCode, replacement.body).toBe(201);
    expect(replacement.json().orderId).not.toBe(orderId);
    expect(replacement.cookies.find(({ name }) => name === cookieName)?.value).toBeTruthy();
    expect(await orderRow(orderId)).toMatchObject({
      guest_analytics_digest: original.guest_analytics_digest, status: "cancelled"
    });
    const updated = await orderRow(replacement.json().orderId);
    expect(updated.guest_analytics_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.guest_analytics_digest).not.toBe(original.guest_analytics_digest);
  });
});
