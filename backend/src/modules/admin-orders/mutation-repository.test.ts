import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AdminOrderError } from "./errors.js";
import {
  adminOrderMutationFingerprint,
  AdminOrderMutationRepository
} from "./mutation-repository.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const actor = {
  authSubject: "user_admin",
  userId: "22222222-2222-4222-8222-222222222222"
};
const input = { expectedRevision: 0, reason: "Production work confirmed" };

function database(handler: (sql: string, values: unknown[] | undefined) => unknown) {
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    const sql = String(statement);
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }
    return handler(sql, values) as { rows: unknown[] };
  });
  const client = {
    query,
    release: vi.fn()
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client)
  } as unknown as Pool;
  return { client, pool, query };
}

describe("admin order mutation repository", () => {
  it("locks, validates, updates, and records one actor-attributed event", async () => {
    const fingerprint = adminOrderMutationFingerprint(
      "start_production",
      orderId,
      input,
    );
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("select metadata from order_events")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("select id, status, payment_status")) {
        return {
          rows: [{
            fulfillment_status: "queued",
            id: orderId,
            paid_at: "2026-10-26T10:00:00.000Z",
            payment_status: "paid",
            revision: 0,
            status: "paid"
          }]
        };
      }
      if (sql.includes("update orders")) {
        return {
          rows: [{
            fulfillment_status: "in_progress",
            id: orderId,
            payment_status: "paid",
            revision: 1,
            status: "in_production",
            transitioned_at: "2026-10-26T12:00:00.000Z"
          }]
        };
      }
      if (sql.includes("insert into order_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new AdminOrderMutationRepository(db.pool);

    const result = await repository.mutate(
      orderId,
      "start_production",
      actor,
      input,
      "start-production-1",
      fingerprint,
    );

    expect(result).toEqual({
      command: "start_production",
      fulfillmentStatus: "in_progress",
      orderId,
      orderStatus: "in_production",
      paymentStatus: "paid",
      replayed: false,
      revision: 1,
      transitionedAt: "2026-10-26T12:00:00.000Z"
    });
    const update = db.query.mock.calls.find(([sql]) => String(sql).includes("update orders"));
    expect(update?.[1]).toEqual([
      orderId,
      "start_production",
      "in_production",
      "in_progress",
      0
    ]);
    const event = db.query.mock.calls.find(([sql]) => String(sql).includes("insert into order_events"));
    expect(event?.[1]?.[1]).toBe(actor.authSubject);
    expect(event?.[1]?.[2]).toBe(actor.userId);
    expect(event?.[1]?.[3]).toBe("order.production_started");
    expect(String(event?.[1]?.[6])).not.toContain("start-production-1");
    expect(JSON.parse(String(event?.[1]?.[7]))).toMatchObject({
      command: "start_production",
      expectedRevision: 0,
      requestFingerprint: fingerprint,
      result: { revision: 1 }
    });
  });

  it("replays the stored result without another update", async () => {
    const fingerprint = adminOrderMutationFingerprint(
      "start_production",
      orderId,
      input,
    );
    const stored = {
      command: "start_production",
      fulfillmentStatus: "in_progress",
      orderId,
      orderStatus: "in_production",
      paymentStatus: "paid",
      replayed: false,
      revision: 1,
      transitionedAt: "2026-10-26T12:00:00.000Z"
    };
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("select metadata from order_events")) {
        return { rows: [{ metadata: { requestFingerprint: fingerprint, result: stored } }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new AdminOrderMutationRepository(db.pool);

    await expect(repository.mutate(
      orderId,
      "start_production",
      actor,
      input,
      "start-production-1",
      fingerprint,
    )).resolves.toEqual({ ...stored, replayed: true });
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update orders"))).toBe(false);
  });

  it("rejects idempotency reuse with different input", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("select metadata from order_events")) {
        return { rows: [{ metadata: { requestFingerprint: "different" } }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new AdminOrderMutationRepository(db.pool);

    await expect(repository.mutate(
      orderId,
      "start_production",
      actor,
      input,
      "reused-key",
      adminOrderMutationFingerprint("start_production", orderId, input),
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      statusCode: 409
    });
    expect(db.query).toHaveBeenCalledWith("rollback");
  });

  it("rejects a stale revision before updating the order", async () => {
    const db = database((sql) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
      if (sql.includes("select metadata from order_events")) return { rows: [] };
      if (sql.includes("select id from users")) return { rows: [{ id: actor.userId }] };
      if (sql.includes("select id, status, payment_status")) {
        return {
          rows: [{
            fulfillment_status: "queued",
            id: orderId,
            paid_at: "2026-10-26T10:00:00.000Z",
            payment_status: "paid",
            revision: 2,
            status: "paid"
          }]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new AdminOrderMutationRepository(db.pool);

    await expect(repository.mutate(
      orderId,
      "start_production",
      actor,
      input,
      "stale-revision",
      adminOrderMutationFingerprint("start_production", orderId, input),
    )).rejects.toBeInstanceOf(AdminOrderError);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("update orders"))).toBe(false);
  });
});
