import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import { AdminMessagingRepository } from "../../modules/admin-messaging/repository.js";
import type { RefundProvider } from "../../modules/refunds/provider.js";
import { RefundRepository } from "../../modules/refunds/repository.js";
import { RefundService } from "../../modules/refunds/service.js";
import { StripeWebhookInbox } from "../../modules/refunds/webhook-inbox.js";
import { TransactionalNotificationRepository } from "../../modules/transactional-notifications/repository.js";
import {
  operationalFixtureIds,
  seedOperationalFixtures,
  verifyOperationalFixtures,
  type OperationalFixtureReferences
} from "./operational.js";

loadBackendEnvironment();

const integrationDescribe =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const references: OperationalFixtureReferences = {
  adminUserId: "30000000-0085-4000-8000-000000000100",
  awaitingAdminOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000001", publicOrderNumber: "OPERATIONAL-1" },
  awaitingCustomerOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000002", publicOrderNumber: "OPERATIONAL-2" },
  cancelledOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000003", publicOrderNumber: "OPERATIONAL-3" },
  deliveredOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000004", publicOrderNumber: "OPERATIONAL-4", shipmentId: "30000000-0085-4000-8000-000000000104" },
  failedRefundOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000005", publicOrderNumber: "OPERATIONAL-5" },
  fullRefundOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000006", publicOrderNumber: "OPERATIONAL-6" },
  manualReviewRefundOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000007", publicOrderNumber: "OPERATIONAL-7" },
  partialRefundOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000008", publicOrderNumber: "OPERATIONAL-8" },
  resolvedOrder: { capturedAmountCents: 10000, id: "30000000-0085-4000-8000-000000000009", publicOrderNumber: "OPERATIONAL-9" }
};

const orderReferences = [
  references.awaitingAdminOrder,
  references.awaitingCustomerOrder,
  references.cancelledOrder,
  references.deliveredOrder,
  references.failedRefundOrder,
  references.fullRefundOrder,
  references.manualReviewRefundOrder,
  references.partialRefundOrder,
  references.resolvedOrder
];

integrationDescribe("operational fixture worker isolation", () => {
  let pool: Pool;
  const provider = {
    createRefund: vi.fn(async () => { throw new Error("provider must not be called"); }),
    reconcilePayment: vi.fn(async () => { throw new Error("provider must not be called"); }),
    retrieveRefund: vi.fn(async () => { throw new Error("provider must not be called"); })
  } satisfies RefundProvider;

  async function cleanup() {
    const orderIds = orderReferences.map((entry) => entry.id);
    const refundIds = Object.values(operationalFixtureIds.refunds);
    await pool.query(
      `delete from messaging_webhook_events where id = any($1::uuid[])`,
      [Object.values(operationalFixtureIds.messagingWebhooks)],
    );
    await pool.query(
      `delete from stripe_webhook_events where id = any($1::uuid[])`,
      [Object.values(operationalFixtureIds.stripeWebhooks)],
    );
    await pool.query(
      `delete from refund_effects where refund_operation_id = any($1::uuid[])`,
      [refundIds],
    );
    await pool.query(
      `delete from transactional_notification_intents where order_id = any($1::uuid[])`,
      [orderIds],
    );
    await pool.query(
      `delete from message_delivery_jobs where id = any($1::uuid[])`,
      [Object.values(operationalFixtureIds.jobs)],
    );
    await pool.query(
      `delete from order_messages where order_id = any($1::uuid[])`,
      [orderIds],
    );
    await pool.query(
      `delete from refund_operations where id = any($1::uuid[])`,
      [refundIds],
    );
    await pool.query(
      `delete from payment_reconciliation_state where order_id = any($1::uuid[])`,
      [orderIds],
    );
    await pool.query(
      `delete from order_conversations where order_id = any($1::uuid[])`,
      [orderIds],
    );
    await pool.query(`delete from shipments where id = $1::uuid`, [references.deliveredOrder.shipmentId]);
    await pool.query(`delete from orders where id = any($1::uuid[])`, [orderIds]);
    await pool.query(`delete from users where id = $1::uuid`, [references.adminUserId]);
  }

  beforeAll(async () => {
    const { createDatabasePool } = await import("../client.js");
    pool = createDatabasePool();
    await cleanup();
    await pool.query(
      `insert into users (id, auth_provider, auth_subject, email, display_name)
       values ($1::uuid, 'clerk', 'fixture-operational-admin',
               'admin@example.test', 'Operational Fixture Admin')`,
      [references.adminUserId],
    );

    for (const order of orderReferences) {
      const cancelled = order.id === references.cancelledOrder.id;
      const delivered = order.id === references.deliveredOrder.id;
      const partial = order.id === references.partialRefundOrder.id;
      const full = order.id === references.fullRefundOrder.id;
      const total = partial ? 10000 : full ? 6000 : order.id === references.manualReviewRefundOrder.id ? 8000 : order.id === references.failedRefundOrder.id ? 7000 : 5000;
      const paymentIntentId = partial
        ? "pi_test_fixture_partial"
        : full
          ? "pi_test_fixture_full"
          : order.id === references.manualReviewRefundOrder.id
            ? "pi_test_fixture_manual"
            : order.id === references.failedRefundOrder.id
              ? "pi_test_fixture_failed"
              : null;
      await pool.query(
        `insert into orders (
           id, public_order_number, status, payment_status, fulfillment_status,
           customer_email, preferred_contact_method, shipping_name,
           shipping_address, subtotal_cents, total_cents, currency,
           stripe_payment_intent_id, paid_at, cancelled_at, completed_at,
           created_at, updated_at
         ) values (
           $1::uuid, $2, $3::order_status, $4::payment_status,
           $5::fulfillment_status, 'fixture-customer@example.test', 'email',
           'DO NOT SHIP - TEST FIXTURE',
           '{"line1":"DO NOT SHIP - TEST FIXTURE","city":"Fixture City","state":"NY","postalCode":"10001","country":"US"}'::jsonb,
           $6, $6, 'usd', $7, $8::timestamptz, $9::timestamptz,
           $10::timestamptz, '2026-10-10T12:00:00.000Z',
           '2026-10-10T12:00:00.000Z'
         )`,
        [
          order.id,
          order.publicOrderNumber,
          cancelled ? "cancelled" : delivered ? "completed" : "paid",
          partial ? "partially_refunded" : full ? "refunded" : "paid",
          cancelled ? "cancelled" : delivered || partial ? "delivered" : "queued",
          total,
          paymentIntentId,
          "2026-10-10T12:00:00.000Z",
          cancelled ? "2026-10-16T12:00:00.000Z" : null,
          delivered ? "2026-10-16T12:00:00.000Z" : null
        ],
      );
    }

    await pool.query(
      `insert into shipments (
         id, order_id, shipment_number, status, carrier, tracking_number,
         tracking_url, ship_to_name_snapshot, ship_to_address_snapshot,
         shipped_at, delivered_at, completed_at, created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, 1, 'completed', 'TEST_CARRIER',
         'TEST-TRACKING-ONLY', 'https://example.test/tracking/TEST-TRACKING-ONLY',
         'DO NOT SHIP - TEST FIXTURE',
         '{"line1":"DO NOT SHIP - TEST FIXTURE","city":"Fixture City","state":"NY","postalCode":"10001","country":"US"}'::jsonb,
         '2026-10-14T12:00:00.000Z', '2026-10-15T12:00:00.000Z',
         '2026-10-16T12:00:00.000Z', '2026-10-14T12:00:00.000Z',
         '2026-10-16T12:00:00.000Z'
       )`,
      [references.deliveredOrder.shipmentId, references.deliveredOrder.id],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it("seeds twice and leaves every worker with zero eligible fixture work", async () => {
    const input = { claimOwnedRow: async () => undefined, references };

    const first = await seedOperationalFixtures(pool, input);
    const second = await seedOperationalFixtures(pool, input);

    expect(second).toEqual(first);
    await expect(verifyOperationalFixtures(pool, references)).resolves.toEqual(first);

    const refunds = new RefundRepository(pool);
    await expect(
      refunds.claimDispatch(operationalFixtureIds.refunds.manualReview, "fixture-worker"),
    ).resolves.toBeNull();
    await expect(refunds.claimRecoveryCandidates(25, "fixture-worker")).resolves.toEqual([]);

    const notifications = new TransactionalNotificationRepository(
      pool,
      "https://example.test",
      "test",
    );
    await expect(notifications.reconcileLifecycle()).resolves.toBe(0);
    await expect(notifications.promoteRefundEffects()).resolves.toBe(0);
    await expect(
      notifications.claimMaterializationIntents("fixture-worker"),
    ).resolves.toEqual([]);

    const messaging = new AdminMessagingRepository(pool);
    await expect(messaging.claimDeliveryJobs(25, "fixture-worker")).resolves.toEqual([]);

    const webhookInbox = new StripeWebhookInbox(pool, provider);
    await expect(webhookInbox.runOnce()).resolves.toEqual({ attempted: 0, completed: 0 });
    expect(provider.createRefund).not.toHaveBeenCalled();
    expect(provider.reconcilePayment).not.toHaveBeenCalled();
    expect(provider.retrieveRefund).not.toHaveBeenCalled();
  });

  it("reads the manual-review refund without provider recovery", async () => {
    const repository = new RefundRepository(pool);
    const service = new RefundService(repository, provider);

    await expect(
      service.getOperation(operationalFixtureIds.refunds.manualReview),
    ).resolves.toMatchObject({
      manualReviewRequired: true,
      pendingReason: "unknown_outcome",
      status: "pending"
    });
    expect(provider.reconcilePayment).not.toHaveBeenCalled();
    expect(provider.retrieveRefund).not.toHaveBeenCalled();
  });
});
