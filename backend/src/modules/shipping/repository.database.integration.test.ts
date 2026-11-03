import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBackendEnvironment } from "../../config/load-environment.js";
import {
  addressCorrectionFingerprint,
  exportFingerprint,
  ShippingExportRepository
} from "./repository.js";

loadBackendEnvironment();
const integrationDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

integrationDescribe("shipping export database transaction", () => {
  let pool: Pool;
  let repository: ShippingExportRepository;
  const userId = randomUUID();
  const authSubject = `shipping-export-admin-${userId}`;
  const orderId = randomUUID();
  const secondOrderId = randomUUID();
  const fulfillmentId = randomUUID();
  const secondFulfillmentId = randomUUID();
  const publicOrderNumber = `KAP-SHIP-${orderId.slice(0, 8)}`;
  const actor = { authSubject, userId };
  const input = [{
    expectedRevision: 7,
    orderId,
    package: {
      description: "Graduation stole",
      heightInches: 2,
      lengthInches: 10,
      weightOunces: 12.5,
      widthInches: 8
    }
  }, {
    expectedRevision: 7,
    orderId: secondOrderId,
    package: {
      description: "Second graduation stole",
      heightInches: 3,
      lengthInches: 11,
      weightOunces: 14,
      widthInches: 9
    }
  }];

  beforeAll(async () => {
    const { createDatabasePool } = await import("../../database/client.js");
    pool = createDatabasePool();
    repository = new ShippingExportRepository(pool);
    await pool.query(
      `insert into users (id, auth_provider, auth_subject, display_name)
       values ($1, 'clerk', $2, 'Shipping Admin')`,
      [userId, authSubject],
    );
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status,
         paid_at, customer_email, customer_phone, shipping_name, shipping_address,
         shipping_address_status, subtotal_cents, total_cents, currency, revision
       ) values (
         $1, $2, 'ready_to_ship', 'paid', 'ready_to_ship', now(),
         'shipping-canary@example.test', '+1 617 555 0100', 'Shipping Canary',
         '{"line1":"123 Main St","city":"Boston","state":"MA","postalCode":"02108","country":"US"}'::jsonb,
         'valid', 5000, 5000, 'usd', 7
       )`,
      [orderId, publicOrderNumber],
    );
    await pool.query(
      `insert into orders (
         id, public_order_number, status, payment_status, fulfillment_status,
         paid_at, customer_email, customer_phone, shipping_name, shipping_address,
         shipping_address_status, subtotal_cents, total_cents, currency, revision
       ) values (
         $1, $2, 'ready_to_ship', 'paid', 'ready_to_ship', now(),
         'second-shipping-canary@example.test', null, 'Second Shipping Canary',
         '{"line1":"456 Main St","city":"Cambridge","state":"MA","postalCode":"02139","country":"US"}'::jsonb,
         'valid', 3000, 3000, 'usd', 7
       )`,
      [secondOrderId, `KAP-SHIP-${secondOrderId.slice(0, 8)}`],
    );
    await pool.query(
      `insert into order_items (
         order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, customization_snapshot
       ) values ($1, 2, 2500, 5000, 'usd', '{"title":"Graduation Stole"}'::jsonb, '{}'::jsonb)`,
      [orderId],
    );
    await pool.query(
      `insert into order_items (
         order_id, quantity, unit_amount_cents, total_amount_cents, currency,
         listing_snapshot, customization_snapshot
       ) values ($1, 1, 3000, 3000, 'usd', '{"title":"Second Stole"}'::jsonb, '{}'::jsonb)`,
      [secondOrderId],
    );
    await pool.query(
      `insert into order_fulfillments (
         id, order_id, fulfillment_number, status, ready_to_ship_at,
         order_snapshot, shipping_name_snapshot, shipping_address_snapshot
       ) values (
         $1, $2, 1, 'ready_to_ship', now(), '{}'::jsonb, 'Shipping Canary',
         '{"line1":"123 Main St","city":"Boston","state":"MA","postalCode":"02108","country":"US"}'::jsonb
       )`,
      [fulfillmentId, orderId],
    );
    await pool.query(
      `insert into order_fulfillments (
         id, order_id, fulfillment_number, status, ready_to_ship_at,
         order_snapshot, shipping_name_snapshot, shipping_address_snapshot
       ) values (
         $1, $2, 1, 'ready_to_ship', now(), '{}'::jsonb, 'Second Shipping Canary',
         '{"line1":"456 Main St","city":"Cambridge","state":"MA","postalCode":"02139","country":"US"}'::jsonb
       )`,
      [secondFulfillmentId, secondOrderId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    const batches = await pool.query<{ id: string }>(
      `select id from shipping_export_batches where actor_user_id = $1`,
      [userId],
    );
    const batchIds = batches.rows.map((row) => row.id);
    if (batchIds.length) {
      await pool.query(`delete from shipping_export_mutation_receipts where batch_id = any($1::uuid[])`, [batchIds]);
      await pool.query(`delete from shipping_export_active_memberships where batch_id = any($1::uuid[])`, [batchIds]);
      await pool.query(`update shipments set active_shipping_export_batch_id = null where active_shipping_export_batch_id = any($1::uuid[])`, [batchIds]);
      await pool.query(`delete from shipping_export_batch_items where batch_id = any($1::uuid[])`, [batchIds]);
      await pool.query(`delete from shipping_export_batches where id = any($1::uuid[])`, [batchIds]);
    }
    await pool.query(`delete from admin_audit_events where actor_user_id = $1`, [userId]);
    await pool.query(`delete from orders where id = any($1::uuid[])`, [[orderId, secondOrderId]]);
    await pool.query(`delete from users where id = $1`, [userId]);
    await pool.end();
  });

  it("creates, replays, re-downloads immutable bytes, cancels, and purges PII", async () => {
    const conflictingInput = input.map((row, index) => index === 0
      ? { ...row, package: { ...row.package, weightOunces: 18 } }
      : row);
    const attempts = [
      { fingerprint: exportFingerprint(input), key: "shipping-db-create-key-0001", rows: input },
      { fingerprint: exportFingerprint(conflictingInput), key: "shipping-db-create-key-0002", rows: conflictingInput }
    ];
    const outcomes = await Promise.allSettled(attempts.map((attempt) =>
      repository.createBatch(
        actor, attempt.rows, attempt.key, attempt.fingerprint, `request-${attempt.key}`,
      )));
    const fulfilledIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toMatchObject({ reason: { code: "EXPORT_ALREADY_PREPARED" } });
    const winner = attempts[fulfilledIndex];
    const first = (outcomes[fulfilledIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof repository.createBatch>>>).value;
    const replay = await repository.createBatch(
      actor, winner.rows, winner.key, winner.fingerprint, "shipping-db-retry",
    );

    expect(first).toMatchObject({ replayed: false, rowCount: 2 });
    expect(replay).toEqual({ ...first, replayed: true });
    const before = await repository.download(first.batchId);
    expect(before.bytes.toString("utf8")).toContain("shipping-canary@example.test");
    expect(before.bytes.toString("utf8")).toContain("second-shipping-canary@example.test");
    expect(before.bytes.toString("utf8")).not.toContain(orderId);

    await pool.query(
      `update orders set shipping_name = 'Changed Later',
         shipping_address = '{"line1":"999 Changed","city":"Boston","state":"MA","postalCode":"02109","country":"US"}'::jsonb
       where id = $1`,
      [orderId],
    );
    const after = await repository.download(first.batchId);
    expect(after.sha256).toBe(before.sha256);
    expect(after.bytes.equals(before.bytes)).toBe(true);

    const cancelInput = { expectedStatus: "prepared" as const, intent: "no_label_purchased" as const, reason: "Package data changed" };
    const cancelled = await repository.mutateBatch(
      "cancel",
      first.batchId,
      actor,
      cancelInput,
      "shipping-db-cancel-key-0001",
      "a".repeat(64),
      "shipping-db-cancel-request",
    );
    expect(cancelled).toMatchObject({ status: "cancelled" });
    await expect(repository.mutateBatch(
      "cancel", first.batchId, actor, cancelInput,
      "shipping-db-cancel-key-0001", "a".repeat(64), "shipping-db-cancel-retry",
    )).resolves.toMatchObject({ replayed: true, status: "cancelled" });
    await expect(repository.mutateBatch(
      "cancel", first.batchId, actor, cancelInput,
      "shipping-db-cancel-key-0001", "b".repeat(64), "shipping-db-cancel-conflict",
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(repository.download(first.batchId)).rejects.toMatchObject({
      code: "EXPORT_BATCH_INACTIVE", statusCode: 410
    });
    await expect(repository.detail(first.batchId)).resolves.toMatchObject({
      allowedActions: [],
      status: "cancelled"
    });
    expect((await repository.list(["prepared", "expired"], undefined, 25)).batches)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: first.batchId })]));

    const correction = {
      address: {
        city: "Somerville", country: "US" as const, line1: "10 Corrected Way",
        postalCode: "02143", state: "MA"
      },
      expectedRevision: 7,
      intent: "correct_shipping_address" as const,
      name: "Corrected Recipient",
      reason: "Customer confirmed a corrected destination"
    };
    const correctionFingerprint = addressCorrectionFingerprint(orderId, correction);
    const corrected = await repository.correctAddress(
      orderId, actor, correction, "shipping-db-address-key-0001", correctionFingerprint,
    );
    const correctedReplay = await repository.correctAddress(
      orderId, actor, correction, "shipping-db-address-key-0001", correctionFingerprint,
    );
    expect(corrected).toMatchObject({ replayed: false, revision: 8, shippingAddressStatus: "valid" });
    expect(correctedReplay).toEqual({ ...corrected, replayed: true });
    const snapshots = await pool.query<{
      fulfillment_name: string;
      historical_name: string;
      order_name: string;
      shipment_name: string;
    }>(
      `select o.shipping_name as order_name,
              f.shipping_name_snapshot as fulfillment_name,
              s.ship_to_name_snapshot as shipment_name,
              i.row_snapshot->>'fullName' as historical_name
       from orders o
       join order_fulfillments f on f.order_id = o.id and f.fulfillment_number = 1
       join shipments s on s.order_id = o.id
       join shipping_export_batch_items i on i.shipment_id = s.id
       where o.id = $1`,
      [orderId],
    );
    expect(snapshots.rows[0]).toEqual({
      fulfillment_name: "Corrected Recipient",
      historical_name: "Shipping Canary",
      order_name: "Corrected Recipient",
      shipment_name: "Corrected Recipient"
    });

    const reexportInput = winner.rows.map((row) => row.orderId === orderId
      ? { ...row, expectedRevision: 8 }
      : row);
    const reexport = await repository.createBatch(
      actor,
      reexportInput,
      "shipping-db-create-key-0003",
      exportFingerprint(reexportInput),
      "shipping-db-reexport-request",
    );

    await pool.query(
      `update shipping_export_batches
       set created_at = now() - interval '31 days',
           expires_at = now() - interval '1 day'
       where id = any($1::uuid[])`,
      [[first.batchId, reexport.batchId]],
    );
    await expect(repository.purgeExpired()).resolves.toEqual({ purged: 2 });
    const releaseInput = {
      expectedStatus: "expired" as const,
      intent: "no_label_purchased" as const,
      reason: "Confirmed that no labels were purchased"
    };
    await expect(repository.mutateBatch(
      "release", reexport.batchId, actor, releaseInput,
      "shipping-db-release-key-001", "f".repeat(64), "shipping-db-release-request",
    )).resolves.toMatchObject({ replayed: false, status: "expired" });
    await expect(repository.mutateBatch(
      "release", reexport.batchId, actor, releaseInput,
      "shipping-db-release-key-001", "f".repeat(64), "shipping-db-release-retry",
    )).resolves.toMatchObject({ replayed: true, status: "expired" });
    await expect(repository.detail(reexport.batchId)).resolves.toMatchObject({
      allowedActions: [],
      status: "expired"
    });
    expect((await repository.list(["prepared", "expired"], undefined, 25)).batches)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: reexport.batchId })]));
    const stored = await pool.query<{
      active_count: number;
      row_snapshot: unknown;
      status: string;
    }>(
      `select b.status, i.row_snapshot,
              (select count(*)::integer from shipping_export_active_memberships m where m.batch_id = b.id) as active_count
       from shipping_export_batches b
       join shipping_export_batch_items i on i.batch_id = b.id
       where b.id = $1`,
      [first.batchId],
    );
    expect(stored.rows[0]).toMatchObject({ active_count: 0, row_snapshot: null, status: "cancelled" });
  });
});
