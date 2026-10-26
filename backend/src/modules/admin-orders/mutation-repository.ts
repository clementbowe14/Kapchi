import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AdminOrderError } from "./errors.js";
import { resolveAdminOrderTransition } from "./lifecycle.js";
import type {
  AdminOrderMutationActor,
  AdminOrderMutationCommand,
  AdminOrderMutationInput,
  AdminOrderMutationResult,
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus
} from "./types.js";

type LockedOrderRow = QueryResultRow & {
  fulfillment_status: FulfillmentStatus;
  id: string;
  paid_at: Date | string | null;
  payment_status: PaymentStatus;
  revision: number;
  status: OrderStatus;
};

type UpdatedOrderRow = QueryResultRow & {
  fulfillment_status: FulfillmentStatus;
  id: string;
  payment_status: PaymentStatus;
  revision: number;
  status: OrderStatus;
  transitioned_at: Date | string;
};

type ReplayRow = QueryResultRow & {
  metadata: unknown;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function adminOrderMutationFingerprint(
  command: AdminOrderMutationCommand,
  orderId: string,
  input: AdminOrderMutationInput,
) {
  return sha256(JSON.stringify(canonical({ command, input, orderId })));
}

function transitionKey(orderId: string, idempotencyKey: string) {
  return `admin-order:${orderId}:${sha256(idempotencyKey)}`;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function replayResult(metadataValue: unknown, fingerprint: string) {
  const metadata = object(metadataValue);
  if (metadata?.requestFingerprint !== fingerprint) {
    throw new AdminOrderError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different order mutation.",
      409,
    );
  }
  const result = object(metadata.result);
  if (
    !result ||
    (result.command !== "start_production" && result.command !== "mark_ready_to_ship") ||
    typeof result.orderId !== "string" ||
    typeof result.orderStatus !== "string" ||
    typeof result.paymentStatus !== "string" ||
    typeof result.fulfillmentStatus !== "string" ||
    typeof result.revision !== "number" ||
    typeof result.transitionedAt !== "string"
  ) {
    throw new AdminOrderError(
      "ORDER_MUTATION_REPLAY_UNAVAILABLE",
      "The previous order mutation result is unavailable.",
      500,
    );
  }
  return {
    ...result,
    replayed: true
  } as AdminOrderMutationResult;
}

async function transaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export class AdminOrderMutationRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(authSubject: string): Promise<AdminOrderMutationActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `
        select id from users
        where auth_provider = 'clerk' and auth_subject = $1 and disabled_at is null
        limit 1
      `,
      [authSubject],
    );
    return result.rows[0]
      ? { authSubject, userId: result.rows[0].id }
      : null;
  }

  async mutate(
    orderId: string,
    command: AdminOrderMutationCommand,
    actor: AdminOrderMutationActor,
    input: AdminOrderMutationInput,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<AdminOrderMutationResult> {
    return transaction(this.pool, async (client) => {
      const identity = transitionKey(orderId, idempotencyKey);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [identity],
      );

      const replay = await client.query<ReplayRow>(
        `select metadata from order_events where transition_key = $1 for update`,
        [identity],
      );
      if (replay.rows[0]) return replayResult(replay.rows[0].metadata, fingerprint);

      const verifiedActor = await client.query<{ id: string }>(
        `
          select id from users
          where id = $1::uuid and auth_provider = 'clerk'
            and auth_subject = $2 and disabled_at is null
          for share
        `,
        [actor.userId, actor.authSubject],
      );
      if (!verifiedActor.rows[0]) {
        throw new AdminOrderError(
          "ORDER_ACTOR_UNAVAILABLE",
          "A verified active administrator profile is required.",
          403,
        );
      }

      const locked = await client.query<LockedOrderRow>(
        `
          select id, status, payment_status, fulfillment_status, paid_at, revision
          from orders where id = $1::uuid
          for update
        `,
        [orderId],
      );
      const before = locked.rows[0];
      if (!before) {
        throw new AdminOrderError("ORDER_NOT_FOUND", "Order not found.", 404);
      }
      if (before.revision !== input.expectedRevision) {
        throw new AdminOrderError(
          "ORDER_REVISION_CONFLICT",
          "The order changed after it was loaded. Refresh the order and try again.",
          409,
        );
      }

      const target = resolveAdminOrderTransition(command, {
        fulfillmentStatus: before.fulfillment_status,
        orderStatus: before.status,
        paidAt: before.paid_at === null ? null : iso(before.paid_at),
        paymentStatus: before.payment_status
      });
      const updated = await client.query<UpdatedOrderRow>(
        `
          update orders
          set status = $3::order_status,
              fulfillment_status = $4::fulfillment_status,
              ready_to_ship_at = case
                when $2 = 'mark_ready_to_ship' then coalesce(ready_to_ship_at, now())
                else ready_to_ship_at
              end,
              revision = revision + 1,
              updated_at = now()
          where id = $1::uuid and revision = $5
          returning id, status, payment_status, fulfillment_status, revision,
                    updated_at as transitioned_at
        `,
        [
          orderId,
          command,
          target.orderStatus,
          target.fulfillmentStatus,
          input.expectedRevision
        ],
      );
      const after = updated.rows[0];
      if (!after) {
        throw new AdminOrderError(
          "ORDER_REVISION_CONFLICT",
          "The order changed after it was loaded. Refresh the order and try again.",
          409,
        );
      }

      const result: AdminOrderMutationResult = {
        command,
        fulfillmentStatus: after.fulfillment_status,
        orderId: after.id,
        orderStatus: after.status,
        paymentStatus: after.payment_status,
        replayed: false,
        revision: after.revision,
        transitionedAt: iso(after.transitioned_at)
      };
      await client.query(
        `
          insert into order_events (
            order_id, actor_type, actor_id, actor_user_id, event_type,
            from_value, to_value, transition_key, metadata
          ) values (
            $1::uuid, 'admin', $2, $3::uuid, $4, $5, $6, $7, $8::jsonb
          )
        `,
        [
          orderId,
          actor.authSubject,
          actor.userId,
          target.eventType,
          `${before.status}/${before.fulfillment_status}`,
          `${after.status}/${after.fulfillment_status}`,
          identity,
          JSON.stringify({
            before: {
              fulfillmentStatus: before.fulfillment_status,
              orderStatus: before.status,
              paymentStatus: before.payment_status,
              revision: before.revision
            },
            command,
            expectedRevision: input.expectedRevision,
            reason: input.reason ?? null,
            requestFingerprint: fingerprint,
            result
          })
        ],
      );
      return result;
    });
  }
}

export type AdminOrderMutator = Pick<
  AdminOrderMutationRepository,
  "mutate" | "resolveActor"
>;
