import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { AdminOrderRepository } from "./repository.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

type InsertOrder = {
  cancelled?: boolean;
  completed?: boolean;
  createdAt: string;
  customerId?: string;
  discountMinor?: number;
  fulfillmentStatus?: string;
  paymentStatus?: string;
  status?: string;
};

integrationDescribe("AdminOrderRepository database", () => {
  let pool: Pool;
  let repository: AdminOrderRepository;
  let orderIds: string[] = [];
  let customerIds: string[] = [];
  let listingIds: string[] = [];
  let fabricIds: string[] = [];

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new AdminOrderRepository(pool);
  });

  afterEach(async () => {
    if (orderIds.length > 0) {
      await pool.query("delete from refund_operations where order_id = any($1::uuid[])", [orderIds]);
      await pool.query("delete from orders where id = any($1::uuid[])", [orderIds]);
    }
    if (customerIds.length > 0) {
      await pool.query("delete from customers where id = any($1::uuid[])", [customerIds]);
    }
    if (listingIds.length > 0) {
      await pool.query("delete from listings where id = any($1::uuid[])", [listingIds]);
    }
    if (fabricIds.length > 0) {
      await pool.query("delete from fabrics where id = any($1::uuid[])", [fabricIds]);
    }
    orderIds = [];
    customerIds = [];
    listingIds = [];
    fabricIds = [];
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertCustomer() {
    const customerId = randomUUID();
    customerIds.push(customerId);
    await pool.query(
      `insert into customers (id, email, full_name, preferred_contact_method)
       values ($1, 'name+tag@example.test', 'Zoë Quispe', 'email')`,
      [customerId],
    );
    return customerId;
  }

  async function insertOrder(input: InsertOrder) {
    const orderId = randomUUID();
    orderIds.push(orderId);
    const status = input.status ?? "paid";
    const paymentStatus = input.paymentStatus ?? "paid";
    const subtotal = 5000;
    const discount = input.discountMinor ?? 0;
    await pool.query(
      `insert into orders (
         id, public_order_number, customer_id, status, payment_status,
         fulfillment_status, shipping_name, shipping_address,
         subtotal_cents, discount_cents, total_cents, currency,
         stripe_payment_intent_id, paid_at, cancelled_at, completed_at,
         created_at, updated_at
       ) values (
         $1, $2, $3, $4::order_status, $5::payment_status,
         $6::fulfillment_status, 'Zoë Quispe',
         '{"line1":"1 Camino Perú","city":"Cusco"}'::jsonb,
         $7, $8, $9, 'usd', $10,
         case when $5::payment_status = 'paid' then $11::timestamptz else null end,
         case when $12::boolean then $11::timestamptz else null end,
         case when $13::boolean then $11::timestamptz else null end,
         $11::timestamptz, $11::timestamptz
       )`,
      [
        orderId,
        `ADMIN-${orderId}`,
        input.customerId ?? null,
        status,
        paymentStatus,
        input.fulfillmentStatus ?? "queued",
        subtotal,
        discount,
        subtotal - discount,
        `pi_admin_${orderId.replaceAll("-", "")}`,
        input.createdAt,
        input.cancelled ?? false,
        input.completed ?? false
      ],
    );
    return orderId;
  }

  async function insertArchivedItem(orderId: string) {
    const listingId = randomUUID();
    const fabricId = randomUUID();
    const missingAssetId = randomUUID();
    listingIds.push(listingId);
    fabricIds.push(fabricId);
    await pool.query(
      `insert into listings (
         id, slug, title, status, listing_type, base_price_cents,
         currency, archived_at
       ) values ($1, $2, 'Historic Stole', 'archived', 'graduation_stole', 5000, 'usd', now())`,
      [listingId, `historic-${listingId}`],
    );
    await pool.query(
      `insert into fabrics (id, sku, name, status, quantity_on_hand)
       values ($1, $2, 'Historic Navy Satin', 'archived', 10)`,
      [fabricId, `ADMIN-${fabricId}`],
    );
    await pool.query(
      `insert into order_items (
         order_id, listing_id, fabric_id, quantity, unit_amount_cents,
         total_amount_cents, currency, stripe_product_id, stripe_price_id,
         listing_snapshot, fabric_snapshot,
         customization_snapshot, production_notes
       ) values (
         $1, $2, $3, 1, 5000, 5000, 'usd', 'prod_historic', 'price_historic',
         '{"slug":"original-stole","title":"Original Historic Stole"}'::jsonb,
         '{"name":"Original Navy Satin","sku":"ORIGINAL-NAVY"}'::jsonb,
         $4::jsonb,
         'Preserve every accent exactly.'
       )`,
      [
        orderId,
        listingId,
        fabricId,
        JSON.stringify({
          fontOptionId: "font-andean-serif",
          imageAssetId: missingAssetId,
          line1: "Promoción 2027 – Perú",
          line2: "Familia Quispe",
          placement: "right-tail",
          trim: "Oro"
        })
      ],
    );
    return { fabricId, listingId, missingAssetId };
  }

  async function insertFinancialState(orderId: string) {
    await pool.query(
      `insert into payment_reconciliation_state (
         order_id, payment_intent_id, provider_account_id, livemode,
         captured_amount_cents, provider_refunded_amount_cents, currency,
         provider_payment_status, reconciliation_status, last_reconciled_at
       ) select id, stripe_payment_intent_id, 'acct_admin_test', false,
                5000, 1000, 'usd', 'succeeded', 'current', now()
         from orders where id = $1`,
      [orderId],
    );
    const succeededId = randomUUID();
    const pendingId = randomUUID();
    await pool.query(
      `insert into refund_operations (
         id, order_id, payment_intent_id, provider_account_id, livemode,
         amount_cents, currency, reason_code, origin, status, pending_reason,
         provider_refund_id, client_idempotency_key, provider_idempotency_key,
         request_fingerprint, succeeded_at
       ) values
         ($1, $3, (select stripe_payment_intent_id from orders where id = $3),
          'acct_admin_test', false, 1000, 'usd', 'requested_by_customer',
          'stripe_external', 'succeeded', null, $4, $5, $6, $7, now()),
         ($2, $3, (select stripe_payment_intent_id from orders where id = $3),
          'acct_admin_test', false, 500, 'usd', 'requested_by_customer',
          'stripe_external', 'pending', 'provider_pending', null, $8, $9, $10, null)`,
      [
        succeededId,
        pendingId,
        orderId,
        `re_admin_${succeededId}`,
        `client-${succeededId}`,
        `provider-${succeededId}`,
        `fingerprint-${succeededId}`,
        `client-${pendingId}`,
        `provider-${pendingId}`,
        `fingerprint-${pendingId}`
      ],
    );
  }

  it("searches normalized contacts, combines drill-down filters, and excludes closed orders by default", async () => {
    const customerId = await insertCustomer();
    const target = await insertOrder({
      createdAt: "2026-10-10T12:00:00.000Z",
      customerId,
      discountMinor: 100,
      status: "in_production"
    });
    const { fabricId, listingId } = await insertArchivedItem(target);
    await insertFinancialState(target);
    await pool.query(
      `update orders
       set customer_email = 'order-snapshot@example.test', preferred_contact_method = 'email'
       where id = $1`,
      [target],
    );
    await insertOrder({
      completed: true,
      createdAt: "2026-10-11T12:00:00.000Z",
      customerId,
      status: "completed"
    });
    await insertOrder({
      cancelled: true,
      createdAt: "2026-10-12T12:00:00.000Z",
      customerId,
      paymentStatus: "unpaid",
      status: "cancelled"
    });

    const page = await repository.search({
      createdFrom: "2026-10-10",
      createdTo: "2026-10-10",
      discountedOnly: true,
      fabricId,
      lifecycle: "ongoing",
      limit: 25,
      listingId,
      paidOnly: true,
      refundedOnly: true,
      search: "NAME+TAG@EXAMPLE.TEST",
      sort: "created_desc"
    });

    expect(page.orders.map((order) => order.id)).toEqual([target]);
    expect(page.orders[0]).toMatchObject({
      customer: { email: "order-snapshot@example.test", name: "Zoë Quispe" },
      payment: {
        captured: { amountMinor: 5000, currency: "usd" },
        pendingRefunds: { amountMinor: 500, currency: "usd" },
        refundableBalance: { amountMinor: 3500, currency: "usd" },
        succeededRefunds: { amountMinor: 1000, currency: "usd" }
      }
    });

    const wildcard = await repository.search({
      discountedOnly: false,
      lifecycle: "all",
      limit: 25,
      paidOnly: false,
      refundedOnly: false,
      search: "%_",
      sort: "created_desc"
    });
    expect(wildcard.orders).toEqual([]);
  });

  it("keeps same-timestamp pagination stable in both created-date directions", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertOrder({ createdAt: "2026-10-15T12:00:00.000Z" });
    }

    for (const sort of ["created_asc", "created_desc"] as const) {
      const first = await repository.search({
        createdFrom: "2026-10-15",
        createdTo: "2026-10-15",
        discountedOnly: false,
        lifecycle: "ongoing",
        limit: 1,
        paidOnly: false,
        refundedOnly: false,
        sort
      });
      const second = await repository.search({
        createdFrom: "2026-10-15",
        createdTo: "2026-10-15",
        cursor: first.nextCursor!,
        discountedOnly: false,
        lifecycle: "ongoing",
        limit: 2,
        paidOnly: false,
        refundedOnly: false,
        sort
      });
      expect(first.orders).toHaveLength(1);
      expect(second.orders).toHaveLength(2);
      expect(new Set([...first.orders, ...second.orders].map((order) => order.id)).size).toBe(3);
      await expect(repository.search({
        cursor: first.nextCursor!,
        discountedOnly: false,
        lifecycle: "ongoing",
        limit: 2,
        paidOnly: false,
        refundedOnly: false,
        sort: sort === "created_asc" ? "created_desc" : "created_asc"
      })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    }
  });

  it("returns immutable production snapshots and flags a missing private asset without fixture substitution", async () => {
    const orderId = await insertOrder({ createdAt: "2026-10-20T12:00:00.000Z" });
    const { missingAssetId } = await insertArchivedItem(orderId);
    await insertFinancialState(orderId);
    await pool.query(
      `insert into order_items (
         order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, customization_snapshot
       ) values ($1, 1, 0, 0, 'usd', '{}'::jsonb, '{}'::jsonb)`,
      [orderId],
    );

    const detail = await repository.detail(orderId);

    const complete = detail.items.find((item) => item.productionNotes !== null)!;
    const incomplete = detail.items.find((item) => item.productionNotes === null)!;
    expect(complete).toMatchObject({
      catalogReference: { fabricStatus: "archived", listingStatus: "archived" },
      customizationAsset: {
        id: missingAssetId,
        recordStatus: null,
        unavailableReason: "ASSET_RECORD_MISSING"
      },
      production: {
        availability: {
          font: "present",
          placement: "present",
          text: "present",
          trim: "present"
        },
        font: "font-andean-serif",
        placement: "right-tail",
        text: { line1: "Promoción 2027 – Perú", line2: "Familia Quispe" },
        trim: "Oro"
      },
      productionNotes: "Preserve every accent exactly.",
      snapshots: {
        listing: { slug: "original-stole", title: "Original Historic Stole" },
        variant: {
          currency: "usd",
          listingPriceVariantId: null,
          stripePriceId: "price_historic",
          stripeProductId: "prod_historic",
          unitAmountMinor: 5000
        }
      }
    });
    expect(incomplete).toMatchObject({
      customizationAsset: {
        id: null,
        recordStatus: null,
        unavailableReason: "ASSET_NOT_SELECTED"
      },
      production: {
        availability: {
          font: "not_stored",
          placement: "not_stored",
          text: "not_stored",
          trim: "not_stored"
        }
      }
    });
    expect(detail.payment).toMatchObject({
      captured: { amountMinor: 5000, currency: "usd" },
      pendingRefunds: { amountMinor: 500, currency: "usd" },
      refundableBalance: { amountMinor: 3500, currency: "usd" },
      succeededRefunds: { amountMinor: 1000, currency: "usd" }
    });
  });

  it("paginates a chronological timeline without duplicating message or refund events", async () => {
    const orderId = await insertOrder({ createdAt: "2026-10-20T12:00:00.000Z" });
    await insertFinancialState(orderId);
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await pool.query(
      `insert into order_conversations (id, order_id, thread_key, last_message_at)
       values ($1, $2, $3, '2026-10-20T13:00:00Z')`,
      [conversationId, orderId, `admin-test:${orderId}`],
    );
    await pool.query(
      `insert into order_messages (
         id, order_id, conversation_id, sender_type, sender_user_id,
         channel, direction, status, body, sent_at, created_at
       ) values (
         $1, $2, $3, 'admin', 'admin_test', 'internal_note', 'internal',
         'sent', 'Production-only note', '2026-10-20T13:00:00Z',
         '2026-10-20T13:00:00Z'
       )`,
      [messageId, orderId, conversationId],
    );
    await pool.query(
      `insert into order_events (
         order_id, actor_type, event_type, transition_key, metadata, created_at
       ) values
         ($1, 'system', 'order.created', $2, '{}'::jsonb, '2026-10-20T12:00:00Z'),
         ($1, 'admin', 'order_note.created', $3, $4::jsonb, '2026-10-20T13:00:00Z')`,
      [
        orderId,
        `admin-order-created:${orderId}`,
        `admin-order-note:${messageId}`,
        JSON.stringify({ targetId: messageId })
      ],
    );

    const first = await repository.timeline(orderId, { limit: 2 });
    const second = await repository.timeline(orderId, {
      cursor: first.nextCursor!,
      limit: 10
    });
    const entries = [...first.entries, ...second.entries];

    expect(entries.map((entry) => entry.occurredAt)).toEqual(
      [...entries.map((entry) => entry.occurredAt)].sort(),
    );
    expect(entries.filter((entry) => entry.kind === "internal_note")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "refund")).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === "event" && entry.payload.eventType === "order_note.created")).toBe(false);
    expect(entries.find((entry) => entry.kind === "internal_note")).toMatchObject({
      visibility: "internal",
      payload: { body: "Production-only note" }
    });
  });

  it("refuses to combine captured and refund money across currencies", async () => {
    const orderId = await insertOrder({ createdAt: "2026-10-22T12:00:00.000Z" });
    await pool.query(
      `insert into payment_reconciliation_state (
         order_id, payment_intent_id, provider_account_id, livemode,
         captured_amount_cents, provider_refunded_amount_cents, currency,
         provider_payment_status, reconciliation_status, last_reconciled_at
       ) select id, stripe_payment_intent_id, 'acct_admin_test', false,
                5000, 0, 'eur', 'succeeded', 'current', now()
         from orders where id = $1`,
      [orderId],
    );

    const detail = await repository.detail(orderId);

    expect(detail.payment).toMatchObject({
      captured: null,
      currencyIntegrity: "mismatch",
      refundableBalance: null,
      succeededRefunds: { amountMinor: 0, currency: "usd" }
    });
  });
});
