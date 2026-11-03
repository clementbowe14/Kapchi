import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  ensureOrderCancellationIntent,
  ensureOrderDeliveryIntent,
  ensureRefundCompletedIntent,
  NotificationIdempotencyConflictError
} from "./producer.js";
import type {
  ClaimedNotificationIntent,
  NotificationStatusFilters,
  RenderedNotification,
  SafeNotificationStatus,
  TransactionalNotificationPayload
} from "./types.js";

type IntentRow = QueryResultRow & {
  id: string;
  kind: ClaimedNotificationIntent["kind"];
  lease_owner: string | null;
  materialization_attempt_count: number;
  order_id: string;
  payload: TransactionalNotificationPayload;
  recipient_address: string | null;
  recipient_channel: ClaimedNotificationIntent["recipientChannel"];
  recipient_failure_code: ClaimedNotificationIntent["recipientFailureCode"];
};

type SafeStatusRow = QueryResultRow & {
  channel: SafeNotificationStatus["channel"];
  created_at: Date | string;
  delivery_attempt_count: number;
  failed_at: Date | string | null;
  failure_code: string | null;
  id: string;
  kind: SafeNotificationStatus["kind"];
  materialization_attempt_count: number;
  public_order_number: string;
  queued_at: Date | string | null;
  state: SafeNotificationStatus["state"];
  succeeded_at: Date | string | null;
  updated_at: Date | string;
};

function timestamp(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeStatus(row: SafeStatusRow): SafeNotificationStatus {
  const failureCode = row.failure_code === null
    ? null
    : (/^[A-Z][A-Z0-9_]{2,63}$/.test(row.failure_code)
        ? row.failure_code
        : "MESSAGE_PROVIDER_FAILED");
  return {
    channel: row.channel,
    createdAt: timestamp(row.created_at)!,
    deliveryAttemptCount: row.delivery_attempt_count,
    failedAt: timestamp(row.failed_at),
    failureCode,
    id: row.id,
    kind: row.kind,
    materializationAttemptCount: row.materialization_attempt_count,
    publicOrderNumber: row.public_order_number,
    queuedAt: timestamp(row.queued_at),
    state: row.state,
    succeededAt: timestamp(row.succeeded_at),
    updatedAt: timestamp(row.updated_at)!
  };
}

async function transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>) {
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

const safeStatusColumns = `
  intents.id,
  intents.kind,
  intents.status as state,
  intents.recipient_channel as channel,
  intents.materialization_attempt_count,
  coalesce(jobs.attempt_count, 0)::integer as delivery_attempt_count,
  coalesce(intents.last_failure_code, jobs.last_error_code) as failure_code,
  intents.created_at,
  intents.queued_at,
  intents.succeeded_at,
  intents.failed_at,
  intents.updated_at,
  orders.public_order_number
`;

const materializationFailureCodes = new Set([
  "MESSAGE_ATTEMPTS_EXHAUSTED",
  "MESSAGE_CHANNEL_UNAVAILABLE",
  "MESSAGE_CONTACT_UNAVAILABLE",
  "MESSAGE_IDEMPOTENCY_CONFLICT",
  "MESSAGE_MATERIALIZATION_FAILED",
  "MESSAGE_PAYLOAD_INVALID",
  "MESSAGE_SMS_CONSENT_UNAVAILABLE"
]);

export class TransactionalNotificationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly orderLookupBaseUrl: string,
    private readonly nodeEnv = "development",
  ) {}

  async reconcileLifecycle(limit = 50) {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    return transaction(this.pool, async (client) => {
      const cancellations = await client.query<{ id: string }>(
        `select orders.id
           from orders
          where orders.status = 'cancelled'
            and orders.paid_at is not null
            and orders.payment_status in ('paid', 'partially_refunded', 'refunded')
            and not exists (
              select 1 from transactional_notification_intents intents
               where intents.idempotency_key = 'transactional:order-cancelled:' || orders.id::text
            )
          order by orders.cancelled_at, orders.id
          limit $1
          for update skip locked`,
        [boundedLimit],
      );
      let created = 0;
      for (const order of cancellations.rows) {
        const result = await ensureOrderCancellationIntent(
          client,
          order.id,
          this.orderLookupBaseUrl,
          this.nodeEnv,
        );
        if (result.created) created += 1;
      }

      const remaining = boundedLimit - cancellations.rows.length;
      if (remaining > 0) {
        const deliveries = await client.query<{ id: string; order_id: string }>(
          `select shipments.id, shipments.order_id
             from shipments
             join orders on orders.id = shipments.order_id
            where shipments.status in ('delivered', 'completed')
              and shipments.delivered_at is not null
              and orders.paid_at is not null
              and orders.payment_status in ('paid', 'partially_refunded', 'refunded')
              and not exists (
                select 1 from transactional_notification_intents intents
                 where intents.idempotency_key = 'transactional:order-delivered:' || shipments.id::text
              )
            order by shipments.delivered_at, shipments.id
            limit $1
            for update of shipments skip locked`,
          [remaining],
        );
        for (const shipment of deliveries.rows) {
          const result = await ensureOrderDeliveryIntent(
            client,
            shipment.order_id,
            shipment.id,
            this.orderLookupBaseUrl,
            this.nodeEnv,
          );
          if (result.created) created += 1;
        }
      }
      return created;
    });
  }

  async promoteRefundEffects(limit = 50) {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    return transaction(this.pool, async (client) => {
      const effects = await client.query<{
        amount_cents: number;
        currency: string;
        effect_id: string;
        order_id: string;
        refund_operation_id: string;
      }>(
        `select effects.id as effect_id, operations.id as refund_operation_id,
                operations.order_id, operations.amount_cents, operations.currency
           from refund_effects effects
           join refund_operations operations on operations.id = effects.refund_operation_id
          where effects.effect_type = 'customer_notification'
            and effects.requested
            and effects.status = 'pending'
            and effects.transactional_notification_intent_id is null
            and operations.status = 'succeeded'
          order by effects.created_at, effects.id
          limit $1
          for update of effects skip locked`,
        [boundedLimit],
      );
      let promoted = 0;
      for (const effect of effects.rows) {
        const intent = await ensureRefundCompletedIntent(
          client,
          {
            amountMinor: effect.amount_cents,
            currency: effect.currency,
            orderId: effect.order_id,
            refundOperationId: effect.refund_operation_id
          },
          this.orderLookupBaseUrl,
          this.nodeEnv,
        );
        const linked = await client.query(
          `update refund_effects
              set transactional_notification_intent_id = $2::uuid,
                  updated_at = now()
            where id = $1::uuid
              and transactional_notification_intent_id is null`,
          [effect.effect_id, intent.id],
        );
        if (linked.rowCount === 1) promoted += 1;
      }
      return promoted;
    });
  }

  async promoteRefundEffect(effectId: string) {
    return transaction(this.pool, async (client) => {
      const result = await client.query<{
        amount_cents: number;
        currency: string;
        order_id: string;
        refund_operation_id: string;
        transactional_notification_intent_id: string | null;
      }>(
        `select operations.id as refund_operation_id, operations.order_id,
                operations.amount_cents, operations.currency,
                effects.transactional_notification_intent_id
           from refund_effects effects
           join refund_operations operations on operations.id = effects.refund_operation_id
          where effects.id = $1::uuid
            and effects.effect_type = 'customer_notification'
            and effects.requested and effects.status = 'pending'
            and operations.status = 'succeeded'
          for update of effects`,
        [effectId],
      );
      const effect = result.rows[0];
      if (!effect) return null;
      if (effect.transactional_notification_intent_id) {
        return effect.transactional_notification_intent_id;
      }
      const intent = await ensureRefundCompletedIntent(
        client,
        {
          amountMinor: effect.amount_cents,
          currency: effect.currency,
          orderId: effect.order_id,
          refundOperationId: effect.refund_operation_id
        },
        this.orderLookupBaseUrl,
        this.nodeEnv,
      );
      await client.query(
        `update refund_effects
            set transactional_notification_intent_id = $2::uuid,
                updated_at = now()
          where id = $1::uuid`,
        [effectId, intent.id],
      );
      return intent.id;
    });
  }

  async claimMaterializationIntents(workerId: string, limit = 50) {
    if (!workerId.trim()) throw new Error("MESSAGE_WORKER_ID_REQUIRED");
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    return transaction(this.pool, async (client) => {
      const exhausted = await client.query<{ id: string; materialization_attempt_count: number }>(
        `update transactional_notification_intents
            set status = 'failed', failed_at = now(),
                last_failure_code = 'MESSAGE_ATTEMPTS_EXHAUSTED',
                lease_owner = null, lease_expires_at = null
          where (
              status in ('pending', 'retryable')
              or (status = 'leased' and lease_expires_at <= now())
            )
            and materialization_attempt_count >= max_materialization_attempts
          returning id, materialization_attempt_count`,
      );
      if (exhausted.rows.length > 0) {
        await client.query(
          `update refund_effects effects
              set status = 'failed',
                  last_error_code = 'MESSAGE_ATTEMPTS_EXHAUSTED',
                  failed_at = coalesce(failed_at, now()),
                  next_attempt_at = null,
                  attempt_count = greatest(
                    attempt_count,
                    exhausted.materialization_attempt_count
                  ),
                  updated_at = now()
             from unnest($1::uuid[], $2::integer[])
               as exhausted(id, materialization_attempt_count)
            where effects.transactional_notification_intent_id = exhausted.id
              and effects.status = 'pending'`,
          [
            exhausted.rows.map((row) => row.id),
            exhausted.rows.map((row) => row.materialization_attempt_count)
          ],
        );
      }
      const result = await client.query<IntentRow>(
        `with candidates as (
           select id
             from transactional_notification_intents
            where (
              (status in ('pending', 'retryable') and next_attempt_at <= now())
              or (status = 'leased' and lease_expires_at <= now())
            )
              and materialization_attempt_count < max_materialization_attempts
            order by next_attempt_at, created_at, id
            limit $2
            for update skip locked
         )
         update transactional_notification_intents intents
            set status = 'leased', lease_owner = $1,
                lease_expires_at = now() + interval '2 minutes',
                materialization_attempt_count = materialization_attempt_count + 1,
                last_failure_code = null
           from candidates
          where intents.id = candidates.id
          returning intents.id, intents.order_id, intents.kind, intents.payload,
                    intents.recipient_channel, intents.recipient_failure_code,
                    intents.lease_owner, intents.materialization_attempt_count`,
        [workerId, boundedLimit],
      );
      return result.rows.map<ClaimedNotificationIntent>((row) => ({
        id: row.id,
        kind: row.kind,
        leaseOwner: row.lease_owner!,
        materializationAttemptCount: row.materialization_attempt_count,
        orderId: row.order_id,
        payload: row.payload,
        recipientChannel: row.recipient_channel,
        recipientFailureCode: row.recipient_failure_code
      }));
    });
  }

  async materializeIntent(input: {
    fromAddress: string;
    intentId: string;
    leaseOwner: string;
    rendered: RenderedNotification;
  }) {
    return transaction(this.pool, async (client) => {
      const intentResult = await client.query<IntentRow>(
        `select id, order_id, kind, payload, recipient_channel,
                recipient_address, recipient_failure_code, lease_owner,
                materialization_attempt_count
           from transactional_notification_intents
          where id = $1::uuid for update`,
        [input.intentId],
      );
      const intent = intentResult.rows[0];
      if (!intent || intent.lease_owner !== input.leaseOwner) {
        throw new Error("MESSAGE_LEASE_LOST");
      }
      if (!intent.recipient_channel || !intent.recipient_address) {
        throw new Error(intent.recipient_failure_code ?? "MESSAGE_CONTACT_UNAVAILABLE");
      }

      const conversation = await client.query<{ id: string }>(
        `insert into order_conversations (order_id, thread_key)
         values ($1::uuid, 'kapchi-order:' || $1::text)
         on conflict (order_id) do update set order_id = excluded.order_id
         returning id`,
        [intent.order_id],
      );
      const messageKey = `transactional-message:${intent.id}`;
      const insertedMessage = await client.query<{ id: string }>(
        `insert into order_messages (
           order_id, conversation_id, sender_type, channel, direction, status,
           to_address, from_address, subject, body, idempotency_key, metadata
         ) values (
           $1::uuid, $2::uuid, 'system', $3::message_channel, 'outbound', 'queued',
           $4, $5, $6, $7, $8, $9::jsonb
         )
        on conflict (idempotency_key) where idempotency_key is not null do nothing
         returning id`,
        [
          intent.order_id,
          conversation.rows[0].id,
          intent.recipient_channel,
          intent.recipient_address,
          input.fromAddress,
          input.rendered.subject,
          input.rendered.body,
          messageKey,
          JSON.stringify({ transactionalNotificationIntentId: intent.id })
        ],
      );
      let messageId = insertedMessage.rows[0]?.id;
      if (!messageId) {
        const existing = await client.query<{
          id: string;
          intent_id: string | null;
          order_id: string;
        }>(
          `select id, order_id,
                  metadata ->> 'transactionalNotificationIntentId' as intent_id
             from order_messages where idempotency_key = $1 for update`,
          [messageKey],
        );
        if (
          !existing.rows[0] ||
          existing.rows[0].order_id !== intent.order_id ||
          existing.rows[0].intent_id !== intent.id
        ) {
          throw new NotificationIdempotencyConflictError();
        }
        messageId = existing.rows[0].id;
      }

      const deliveryKey = `transactional-delivery:${intent.id}`;
      await client.query(
        `insert into message_delivery_jobs (order_message_id, idempotency_key)
         values ($1::uuid, $2)
         on conflict (idempotency_key) do nothing`,
        [messageId, deliveryKey],
      );
      const delivery = await client.query<{ order_message_id: string }>(
        `select order_message_id from message_delivery_jobs
          where idempotency_key = $1 for update`,
        [deliveryKey],
      );
      if (delivery.rows[0]?.order_message_id !== messageId) {
        throw new NotificationIdempotencyConflictError();
      }

      const queued = await client.query(
        `update transactional_notification_intents
            set status = 'queued', order_message_id = $3::uuid,
                queued_at = coalesce(queued_at, now()),
                lease_owner = null, lease_expires_at = null,
                last_failure_code = null
          where id = $1::uuid and status = 'leased' and lease_owner = $2`,
        [intent.id, input.leaseOwner, messageId],
      );
      if (queued.rowCount !== 1) throw new Error("MESSAGE_LEASE_LOST");
      return messageId;
    });
  }

  async failMaterialization(input: {
    failureCode: string;
    intentId: string;
    leaseOwner: string;
    retryable: boolean;
  }) {
    const safeCode = materializationFailureCodes.has(input.failureCode)
      ? input.failureCode
      : "MESSAGE_MATERIALIZATION_FAILED";
    return transaction(this.pool, async (client) => {
      const updated = await client.query<{
        id: string;
        materialization_attempt_count: number;
        status: "failed" | "retryable";
      }>(
        `update transactional_notification_intents
          set status = case
                when $4::boolean and materialization_attempt_count < max_materialization_attempts
                  then 'retryable'::transactional_notification_intent_status
                else 'failed'::transactional_notification_intent_status
              end,
              next_attempt_at = case
                when $4::boolean and materialization_attempt_count < max_materialization_attempts
                  then now() + least(interval '60 minutes',
                    interval '1 minute' * power(2, materialization_attempt_count))
                else next_attempt_at
              end,
              failed_at = case
                when $4::boolean and materialization_attempt_count < max_materialization_attempts
                  then null else now()
              end,
              lease_owner = null, lease_expires_at = null,
              last_failure_code = $3
          where id = $1::uuid and status = 'leased' and lease_owner = $2
          returning id, status, materialization_attempt_count`,
        [input.intentId, input.leaseOwner, safeCode, input.retryable],
      );
      const intent = updated.rows[0];
      if (!intent) return false;
      if (intent.status === "failed") {
        await client.query(
          `update refund_effects
              set status = 'failed', last_error_code = $2,
                  failed_at = coalesce(failed_at, now()),
                  next_attempt_at = null,
                  attempt_count = greatest(attempt_count, $3),
                  updated_at = now()
            where transactional_notification_intent_id = $1::uuid
              and status = 'pending'`,
          [intent.id, safeCode, intent.materialization_attempt_count],
        );
      }
      return true;
    });
  }

  async reconcileDelivery(input: {
    deliveryAttemptCount: number;
    failureCode?: string;
    messageId: string;
    outcome: "succeeded" | "failed";
  }) {
    return transaction(this.pool, async (client) => {
      const safeFailure = input.outcome === "failed"
        ? (/^[A-Z][A-Z0-9_]{2,63}$/.test(input.failureCode ?? "")
            ? input.failureCode!
            : "MESSAGE_PROVIDER_FAILED")
        : null;
      const updated = await client.query<{ id: string }>(
        `update transactional_notification_intents
            set status = $2::transactional_notification_intent_status,
                succeeded_at = case when $2 = 'succeeded' then coalesce(succeeded_at, now()) else null end,
                failed_at = case when $2 = 'failed' then coalesce(failed_at, now()) else null end,
                last_failure_code = $3
          where order_message_id = $1::uuid
            and status = 'queued'
          returning id`,
        [input.messageId, input.outcome, safeFailure],
      );
      const intent = updated.rows[0];
      if (!intent) return false;
      await client.query(
        `update refund_effects
            set status = case when $2 = 'succeeded' then 'succeeded'::refund_effect_status
                              else 'failed'::refund_effect_status end,
                attempt_count = greatest(attempt_count, $3),
                last_error_code = $4,
                succeeded_at = case when $2 = 'succeeded' then coalesce(succeeded_at, now()) else null end,
                failed_at = case when $2 = 'failed' then coalesce(failed_at, now()) else null end,
                next_attempt_at = null,
                updated_at = now()
          where transactional_notification_intent_id = $1::uuid
            and status = 'pending'`,
        [intent.id, input.outcome, input.deliveryAttemptCount, safeFailure],
      );
      return true;
    });
  }

  async listByOrder(orderId: string) {
    const result = await this.pool.query<SafeStatusRow>(
      `select ${safeStatusColumns}
         from transactional_notification_intents intents
         join orders on orders.id = intents.order_id
         left join message_delivery_jobs jobs on jobs.order_message_id = intents.order_message_id
        where intents.order_id = $1::uuid
        order by intents.created_at, intents.id`,
      [orderId],
    );
    return result.rows.map(safeStatus);
  }

  async list(filters: NotificationStatusFilters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const result = await this.pool.query<SafeStatusRow>(
      `select ${safeStatusColumns}
         from transactional_notification_intents intents
         join orders on orders.id = intents.order_id
         left join message_delivery_jobs jobs on jobs.order_message_id = intents.order_message_id
        where ($1::text is null or intents.status::text = $1)
          and ($2::text is null or intents.kind::text = $2)
          and ($3::text is null or coalesce(intents.last_failure_code, jobs.last_error_code) = $3)
        order by intents.created_at desc, intents.id desc
        limit $4`,
      [filters.state ?? null, filters.kind ?? null, filters.failureCode ?? null, limit],
    );
    return result.rows.map(safeStatus);
  }
}

export type TransactionalNotificationWorkerRepository = Pick<
  TransactionalNotificationRepository,
  | "claimMaterializationIntents"
  | "failMaterialization"
  | "list"
  | "listByOrder"
  | "materializeIntent"
  | "promoteRefundEffect"
  | "promoteRefundEffects"
  | "reconcileDelivery"
  | "reconcileLifecycle"
>;
