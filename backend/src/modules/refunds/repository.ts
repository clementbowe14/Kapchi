import type { Pool, PoolClient, QueryResultRow } from "pg";
import { RefundError } from "./errors.js";
import type {
  ProviderPaymentSnapshot,
  ProviderRefund,
  RefundActor,
  RefundOperation,
  RefundRequest,
  RefundSummary
} from "./types.js";

type OperationRow = QueryResultRow & {
  amount_cents: number;
  client_idempotency_key: string;
  created_at: Date | string;
  currency: string;
  dispatch_ever_claimed: boolean;
  failed_at: Date | string | null;
  id: string;
  livemode: boolean;
  manual_review_required: boolean;
  next_reconciliation_at: Date | string | null;
  notification_requested: boolean;
  order_id: string;
  payment_intent_id: string;
  pending_reason: RefundOperation["pendingReason"];
  provider_account_id: string;
  provider_attempt_count: number;
  provider_failure_code: string | null;
  provider_idempotency_key: string;
  provider_refund_id: string | null;
  reason_code: RefundRequest["reasonCode"];
  request_fingerprint: string;
  restock_requested: boolean;
  status: RefundOperation["status"];
  succeeded_at: Date | string | null;
};

type PaymentStateRow = QueryResultRow & {
  captured_amount_cents: number;
  currency: string;
  last_reconciled_at: Date | string;
  reconciliation_status: RefundSummary["reconciliationStatus"];
};

export type StoredRefundOperation = RefundOperation & {
  dispatchEverClaimed: boolean;
  livemode: boolean;
  paymentIntentId: string;
  providerAccountId: string;
  providerAttemptCount: number;
  providerIdempotencyKey: string;
  reasonCode: RefundRequest["reasonCode"];
  requestFingerprint: string;
};

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function operation(row: OperationRow): StoredRefundOperation {
  return {
    amountCents: row.amount_cents,
    clientIdempotencyKey: row.client_idempotency_key,
    createdAt: iso(row.created_at)!,
    currency: row.currency,
    dispatchEverClaimed: row.dispatch_ever_claimed,
    failedAt: iso(row.failed_at),
    failureCode: row.provider_failure_code,
    id: row.id,
    livemode: row.livemode,
    manualReviewRequired: row.manual_review_required,
    nextReconciliationAt: iso(row.next_reconciliation_at),
    notificationRequested: row.notification_requested,
    orderId: row.order_id,
    paymentIntentId: row.payment_intent_id,
    pendingReason: row.pending_reason,
    providerAccountId: row.provider_account_id,
    providerAttemptCount: row.provider_attempt_count,
    providerIdempotencyKey: row.provider_idempotency_key,
    providerRefundId: row.provider_refund_id,
    reasonCode: row.reason_code,
    requestFingerprint: row.request_fingerprint,
    restockRequested: row.restock_requested,
    status: row.status,
    succeededAt: iso(row.succeeded_at)
  };
}

function providerState(refund: ProviderRefund) {
  if (refund.status === "succeeded") {
    return { pendingReason: null, status: "succeeded" as const };
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    return { pendingReason: null, status: "failed" as const };
  }
  return {
    pendingReason:
      refund.status === "requires_action" ? "requires_action" : "provider_pending",
    status: "pending" as const
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

const operationColumns = `
  id, order_id, payment_intent_id, provider_account_id, livemode, amount_cents, currency,
  reason_code, status, pending_reason, provider_refund_id,
  client_idempotency_key, provider_idempotency_key, request_fingerprint,
  provider_failure_code, provider_attempt_count, dispatch_ever_claimed,
  manual_review_required, next_reconciliation_at, restock_requested,
  notification_requested, created_at, succeeded_at, failed_at
`;

export class RefundRepository {
  constructor(private readonly pool: Pool) {}

  async resolveActor(authSubject: string): Promise<RefundActor | null> {
    const result = await this.pool.query<{ id: string }>(
      `
        select id
        from users
        where auth_provider = 'clerk'
          and auth_subject = $1
          and disabled_at is null
        limit 1
      `,
      [authSubject],
    );
    return result.rows[0]
      ? { authSubject, userId: result.rows[0].id }
      : null;
  }

  async findByClientKey(key: string) {
    const result = await this.pool.query<OperationRow>(
      `select ${operationColumns} from refund_operations where client_idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async getOperation(id: string) {
    const result = await this.pool.query<OperationRow>(
      `select ${operationColumns} from refund_operations where id = $1::uuid`,
      [id],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async getOrderPaymentIntent(orderId: string) {
    const result = await this.pool.query<{
      currency: string;
      payment_status: string;
      stripe_payment_intent_id: string | null;
    }>(
      `select currency, payment_status, stripe_payment_intent_id from orders where id = $1::uuid`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) throw new RefundError("ORDER_NOT_FOUND", "Order not found.", 404);
    if (!row.stripe_payment_intent_id || !["paid", "partially_refunded", "refunded"].includes(row.payment_status)) {
      throw new RefundError("REFUND_NOT_ALLOWED", "This order has no refundable captured payment.", 409);
    }
    return {
      currency: row.currency,
      paymentIntentId: row.stripe_payment_intent_id
    };
  }

  async applyReconciliation(orderId: string, snapshot: ProviderPaymentSnapshot) {
    return transaction(this.pool, async (client) => {
      const orderResult = await client.query<{
        currency: string;
        payment_status: string;
        stripe_payment_intent_id: string | null;
      }>(
        `select currency, payment_status, stripe_payment_intent_id from orders where id = $1::uuid for update`,
        [orderId],
      );
      const order = orderResult.rows[0];
      if (!order) throw new RefundError("ORDER_NOT_FOUND", "Order not found.", 404);
      if (order.stripe_payment_intent_id !== snapshot.paymentIntentId) {
        throw new RefundError("REFUND_PAYMENT_MISMATCH", "The reconciled payment does not belong to this order.", 409);
      }
      if (order.currency !== snapshot.currency) {
        throw new RefundError("CURRENCY_MISMATCH", "The captured payment currency does not match the order.", 409);
      }

      await client.query(
        `
          insert into payment_reconciliation_state (
            order_id, payment_intent_id, provider_account_id, livemode,
            latest_charge_id, stripe_api_version, captured_amount_cents,
            provider_refunded_amount_cents, currency, provider_payment_status,
            reconciliation_status, last_reconciled_at
          ) values ($1::uuid, $2, $3, $4, $5, $6, $7, 0, $8, $9, 'stale', null)
          on conflict (order_id) do update set
            payment_intent_id = excluded.payment_intent_id,
            provider_account_id = excluded.provider_account_id,
            livemode = excluded.livemode,
            latest_charge_id = excluded.latest_charge_id,
            stripe_api_version = excluded.stripe_api_version,
            captured_amount_cents = excluded.captured_amount_cents,
            currency = excluded.currency,
            provider_payment_status = excluded.provider_payment_status,
            reconciliation_status = 'stale',
            last_reconciliation_error_code = null
        `,
        [
          orderId,
          snapshot.paymentIntentId,
          snapshot.providerAccountId,
          snapshot.livemode,
          snapshot.latestChargeId,
          snapshot.apiVersion,
          snapshot.capturedAmountCents,
          snapshot.currency,
          snapshot.providerPaymentStatus
        ],
      );

      for (const refund of snapshot.refunds) {
        await this.upsertProviderRefund(client, orderId, snapshot, refund);
      }

      const providerRefunded = snapshot.refunds
        .filter((refund) => refund.status === "succeeded")
        .reduce((sum, refund) => sum + refund.amountCents, 0);

      let totals = await this.totals(client, orderId);
      let conflicted = totals.succeeded + totals.pending > snapshot.capturedAmountCents;
      if (conflicted) {
        await client.query(
          `
            update refund_operations
            set status = 'failed', pending_reason = null,
                provider_failure_code = 'balance_consumed_externally',
                failed_at = now(), next_reconciliation_at = null
            where order_id = $1::uuid and status = 'pending'
              and not dispatch_ever_claimed and provider_attempt_count = 0
          `,
          [orderId],
        );
        await client.query(
          `
            update refund_operations
            set pending_reason = 'provider_conflict', manual_review_required = true,
                next_reconciliation_at = null
            where order_id = $1::uuid and status = 'pending'
              and (dispatch_ever_claimed or provider_attempt_count > 0)
          `,
          [orderId],
        );
        totals = await this.totals(client, orderId);
        conflicted = totals.succeeded + totals.pending > snapshot.capturedAmountCents || totals.conflicts > 0;
      }

      const ledgerMatchesProvider = totals.succeeded === providerRefunded;
      const reconciliationStatus = !ledgerMatchesProvider
        ? "failed"
        : conflicted
          ? "conflicted"
          : "current";
      await client.query(
        `
          update payment_reconciliation_state
          set provider_refunded_amount_cents = $2,
              reconciliation_status = $3::payment_reconciliation_status,
              last_reconciled_at = now(),
              last_reconciliation_error_code = case when $3 = 'failed' then 'LEDGER_PROVIDER_MISMATCH' else null end
          where order_id = $1::uuid
        `,
        [orderId, providerRefunded, reconciliationStatus],
      );
      await client.query(
        `
          update refund_operations
          set reconciliation_lease_owner = null,
              reconciliation_lease_expires_at = null,
              last_reconciliation_error_code = null,
              next_reconciliation_at = case
                when status = 'pending' and pending_reason <> 'provider_conflict'
                  then now() + interval '5 minutes'
                else next_reconciliation_at
              end
          where order_id = $1::uuid
        `,
        [orderId],
      );
      await this.updatePaymentStatus(client, orderId, snapshot.capturedAmountCents, totals.succeeded);
      return { reconciliationStatus };
    });
  }

  private async upsertProviderRefund(
    client: PoolClient,
    orderId: string,
    snapshot: ProviderPaymentSnapshot,
    refund: ProviderRefund,
  ) {
    const state = providerState(refund);
    const matched = refund.metadata.operationId
      ? await client.query<OperationRow>(
          `select ${operationColumns} from refund_operations where id = $1::uuid for update`,
          [refund.metadata.operationId],
        ).catch(() => ({ rows: [] as OperationRow[] }))
      : { rows: [] as OperationRow[] };
    const local = matched.rows[0];
    const validLocal =
      local &&
      local.order_id === orderId &&
      local.payment_intent_id === snapshot.paymentIntentId &&
      local.amount_cents === refund.amountCents &&
      local.currency === refund.currency &&
      local.provider_account_id === snapshot.providerAccountId;

    if (validLocal) {
      await this.updateProviderRow(client, local.id, refund, state);
      return;
    }

    const existing = await client.query<{ id: string }>(
      `
        select id from refund_operations
        where provider_account_id = $1 and livemode = $2 and provider_refund_id = $3
        for update
      `,
      [snapshot.providerAccountId, snapshot.livemode, refund.id],
    );
    if (existing.rows[0]) {
      await this.updateProviderRow(client, existing.rows[0].id, refund, state);
      return;
    }

    const externalKey = `stripe:${snapshot.providerAccountId}:${snapshot.livemode ? "live" : "test"}:${refund.id}`;
    await client.query(
      `
        insert into refund_operations (
          order_id, payment_intent_id, provider_account_id, livemode,
          amount_cents, currency, reason_code, origin, status, pending_reason,
          provider_refund_id, client_idempotency_key, provider_idempotency_key,
          request_fingerprint, provider_failure_code, provider_created_at,
          succeeded_at, failed_at, next_reconciliation_at, manual_review_required
        ) values (
          $1::uuid, $2, $3, $4, $5, $6, 'other', 'stripe_external',
          $7::refund_status, $8::refund_pending_reason, $9, $10, $10,
          encode(digest($10, 'sha256'), 'hex'), $11, $12,
          case when $7 = 'succeeded' then now() else null end,
          case when $7 = 'failed' then now() else null end,
          case when $7 = 'pending' then now() + interval '1 minute' else null end,
          $13
        )
      `,
      [
        orderId,
        snapshot.paymentIntentId,
        snapshot.providerAccountId,
        snapshot.livemode,
        refund.amountCents,
        refund.currency,
        state.status,
        state.pendingReason,
        refund.id,
        externalKey,
        refund.failureCode,
        refund.createdAt,
        Boolean(refund.metadata.operationId && !validLocal)
      ],
    );
  }

  private async updateProviderRow(
    client: PoolClient,
    operationId: string,
    refund: ProviderRefund,
    state: ReturnType<typeof providerState>,
  ) {
    await client.query(
      `
        update refund_operations
        set provider_refund_id = $2, status = $3::refund_status,
            pending_reason = $4::refund_pending_reason,
            provider_failure_code = $5,
            provider_created_at = coalesce(provider_created_at, $6),
            succeeded_at = case when $3 = 'succeeded' then coalesce(succeeded_at, now()) else null end,
            failed_at = case when $3 = 'failed' then coalesce(failed_at, now()) else null end,
            next_reconciliation_at = case when $3 = 'pending' then now() + interval '1 minute' else null end,
            dispatch_lease_owner = null, dispatch_lease_expires_at = null
        where id = $1::uuid
      `,
      [operationId, refund.id, state.status, state.pendingReason, refund.failureCode, refund.createdAt],
    );
  }

  async reserve(
    orderId: string,
    actor: RefundActor,
    request: RefundRequest,
    clientKey: string,
    fingerprint: string,
  ) {
    return transaction(this.pool, async (client) => {
      const stateResult = await client.query<PaymentStateRow & { payment_intent_id: string; provider_account_id: string; livemode: boolean }>(
        `
          select p.payment_intent_id, p.provider_account_id, p.livemode,
                 p.captured_amount_cents, p.currency, p.reconciliation_status,
                 p.last_reconciled_at
          from orders o
          join payment_reconciliation_state p on p.order_id = o.id
          where o.id = $1::uuid
          for update of o, p
        `,
        [orderId],
      );
      const state = stateResult.rows[0];
      if (!state) throw new RefundError("REFUND_RECONCILIATION_UNAVAILABLE", "Payment reconciliation is unavailable.", 503);
      if (state.reconciliation_status !== "current") {
        throw new RefundError("REFUND_RECONCILIATION_UNAVAILABLE", "Payment reconciliation requires attention.", 503);
      }
      if (request.currency !== state.currency) {
        throw new RefundError("CURRENCY_MISMATCH", "Refund currency does not match the captured payment.", 409);
      }
      const totals = await this.totals(client, orderId);
      const remaining = Math.max(0, state.captured_amount_cents - totals.succeeded - totals.pending);
      const amount = request.amountCents ?? remaining;
      if (amount <= 0 || amount > remaining) {
        throw new RefundError("REFUND_BALANCE_CHANGED", "The requested amount exceeds the current refundable balance.", 409);
      }

      const inserted = await client.query<OperationRow>(
        `
          with identity as (select gen_random_uuid() as id)
          insert into refund_operations (
            id, order_id, payment_intent_id, provider_account_id, livemode,
            amount_cents, currency, reason_code, reason_note,
            actor_user_id, actor_auth_subject, origin, status, pending_reason,
            client_idempotency_key, provider_idempotency_key,
            request_fingerprint, restock_requested, notification_requested,
            next_reconciliation_at
          )
          select id, $1::uuid, $2, $3, $4, $5, $6, $7, $8,
                 $9::uuid, $10, 'kapchi', 'pending', 'reserved', $11,
                 'kapchi-refund:' || id::text, $12, $13, $14, now()
          from identity
          returning ${operationColumns}
        `,
        [
          orderId,
          state.payment_intent_id,
          state.provider_account_id,
          state.livemode,
          amount,
          request.currency,
          request.reasonCode,
          request.reasonNote?.trim() || null,
          actor.userId,
          actor.authSubject,
          clientKey,
          fingerprint,
          request.restockRequested,
          request.notificationRequested
        ],
      );
      const row = inserted.rows[0]!;
      await client.query(
        `
          insert into refund_effects (
            refund_operation_id, effect_type, requested, status, idempotency_key
          ) values
            ($1::uuid, 'restock', $2, case when $2 then 'unsupported'::refund_effect_status else 'not_requested'::refund_effect_status end, 'refund-effect:' || $1 || ':restock'),
            ($1::uuid, 'customer_notification', $3, case when $3 then 'pending'::refund_effect_status else 'not_requested'::refund_effect_status end, 'refund-effect:' || $1 || ':notification')
        `,
        [row.id, request.restockRequested, request.notificationRequested],
      );
      return operation(row);
    });
  }

  async claimDispatch(operationId: string, leaseOwner: string) {
    const result = await this.pool.query<OperationRow>(
      `
        update refund_operations
        set dispatch_lease_owner = $2,
            dispatch_lease_expires_at = clock_timestamp() + interval '2 minutes',
            dispatch_ever_claimed = true,
            provider_attempt_count = provider_attempt_count + 1,
            provider_attempt_started_at = clock_timestamp()
        where id = $1::uuid and status = 'pending' and pending_reason = 'reserved'
          and (dispatch_lease_expires_at is null or dispatch_lease_expires_at < clock_timestamp())
        returning ${operationColumns}
      `,
      [operationId, leaseOwner],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async applyProviderResult(operationId: string, refund: ProviderRefund) {
    return transaction(this.pool, async (client) => {
      const rowResult = await client.query<OperationRow>(
        `select ${operationColumns} from refund_operations where id = $1::uuid for update`,
        [operationId],
      );
      const row = rowResult.rows[0];
      if (!row) throw new RefundError("REFUND_NOT_FOUND", "Refund operation not found.", 404);
      await client.query(`select id from orders where id = $1::uuid for update`, [row.order_id]);
      const mismatch =
        (refund.paymentIntentId !== row.payment_intent_id && "payment_intent") ||
        (refund.amountCents !== row.amount_cents && "amount") ||
        (refund.currency !== row.currency && "currency") ||
        (refund.livemode !== row.livemode && "livemode") ||
        (row.provider_refund_id !== null && refund.id !== row.provider_refund_id && "refund_id") ||
        (refund.metadata.operationId !== undefined && refund.metadata.operationId !== row.id && "operation_id") ||
        (refund.metadata.orderId !== undefined && refund.metadata.orderId !== row.order_id && "order_id") ||
        null;
      if (mismatch) {
        const conflict = await client.query<OperationRow>(
          `
            update refund_operations
            set pending_reason = 'provider_conflict', manual_review_required = true,
                provider_failure_code = $2, next_reconciliation_at = null,
                dispatch_lease_owner = null, dispatch_lease_expires_at = null
            where id = $1::uuid
            returning ${operationColumns}
          `,
          [operationId, `provider_response_${mismatch}_mismatch`],
        );
        await client.query(
          `
            update payment_reconciliation_state
            set reconciliation_status = 'conflicted',
                last_reconciliation_error_code = 'PROVIDER_RESPONSE_MISMATCH'
            where order_id = $1::uuid
          `,
          [row.order_id],
        );
        return operation(conflict.rows[0]!);
      }
      const state = providerState(refund);
      await this.updateProviderRow(client, operationId, refund, state);
      const payment = await client.query<{ captured_amount_cents: number }>(
        `select captured_amount_cents from payment_reconciliation_state where order_id = $1::uuid for update`,
        [row.order_id],
      );
      const totals = await this.totals(client, row.order_id);
      await this.updatePaymentStatus(client, row.order_id, payment.rows[0]?.captured_amount_cents ?? 0, totals.succeeded);
      await client.query(
        `
          insert into order_events (
            order_id, actor_type, actor_id, actor_user_id, event_type,
            from_value, to_value, transition_key, metadata
          ) values ($1::uuid, 'stripe', $2, null, 'stripe.refund_transition',
                    $3, $4, $5, $6::jsonb)
          on conflict (transition_key) where transition_key is not null do nothing
        `,
        [
          row.order_id,
          refund.id,
          row.status,
          state.status,
          `refund:${operationId}:${state.status}:${refund.status}`,
          JSON.stringify({ operationId, providerRefundId: refund.id })
        ],
      );
      const updated = await client.query<OperationRow>(
        `select ${operationColumns} from refund_operations where id = $1::uuid`,
        [operationId],
      );
      return operation(updated.rows[0]!);
    });
  }

  async markProviderError(operationId: string, code: string, ambiguous: boolean) {
    const result = await this.pool.query<OperationRow>(
      `
        update refund_operations
        set status = case when $3 then 'pending'::refund_status else 'failed'::refund_status end,
            pending_reason = case when $3 then 'unknown_outcome'::refund_pending_reason else null end,
            provider_failure_code = $2,
            failed_at = case when $3 then null else now() end,
            next_reconciliation_at = case when $3 then now() + interval '1 minute' else null end,
            dispatch_lease_owner = null, dispatch_lease_expires_at = null
        where id = $1::uuid
        returning ${operationColumns}
      `,
      [operationId, code, ambiguous],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async summary(orderId: string): Promise<RefundSummary> {
    const [payment, totals, operations] = await Promise.all([
      this.pool.query<PaymentStateRow>(
        `
          select captured_amount_cents, currency, reconciliation_status, last_reconciled_at
          from payment_reconciliation_state where order_id = $1::uuid
        `,
        [orderId],
      ),
      this.pool.query<{ conflicts: number; pending: number; succeeded: number }>(
        `
          select
            coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0)::int as succeeded,
            coalesce(sum(amount_cents) filter (where status = 'pending'), 0)::int as pending,
            count(*) filter (where status = 'pending' and pending_reason = 'provider_conflict')::int as conflicts
          from refund_operations where order_id = $1::uuid
        `,
        [orderId],
      ),
      this.pool.query<OperationRow>(
        `select ${operationColumns} from refund_operations where order_id = $1::uuid order by created_at desc limit 20`,
        [orderId],
      )
    ]);
    const state = payment.rows[0];
    if (!state) throw new RefundError("REFUND_RECONCILIATION_UNAVAILABLE", "Payment reconciliation is unavailable.", 503);
    const values = totals.rows[0] ?? { conflicts: 0, pending: 0, succeeded: 0 };
    const overcommitted = Math.max(0, values.succeeded + values.pending - state.captured_amount_cents);
    return {
      capabilities: {
        customerNotificationExecution: true,
        itemLevelAllocation: false,
        restockExecution: false
      },
      capturedAmountCents: state.captured_amount_cents,
      currency: state.currency,
      lastReconciledAt: iso(state.last_reconciled_at)!,
      operations: operations.rows.map(operation),
      overcommittedReservedAmountCents: overcommitted,
      pendingAmountCents: values.pending,
      reconciliationStatus: state.reconciliation_status,
      remainingRefundableAmountCents: Math.max(
        0,
        state.captured_amount_cents - values.succeeded - values.pending,
      ),
      succeededAmountCents: values.succeeded
    };
  }

  async claimRecoveryCandidates(limit: number, leaseOwner: string) {
    const result = await this.pool.query<OperationRow>(
      `
        with eligible as (
          select id
          from refund_operations
          where status = 'pending' and not manual_review_required
            and coalesce(next_reconciliation_at, created_at) <= now()
            and (
              reconciliation_lease_expires_at is null
              or reconciliation_lease_expires_at < clock_timestamp()
            )
          order by coalesce(next_reconciliation_at, created_at), created_at
          for update skip locked
          limit $1
        )
        update refund_operations r
        set reconciliation_lease_owner = $2,
            reconciliation_lease_expires_at = clock_timestamp() + interval '2 minutes',
            reconciliation_attempt_count = reconciliation_attempt_count + 1,
            last_reconciliation_attempt_at = clock_timestamp()
        from eligible
        where r.id = eligible.id
        returning r.*
      `,
      [limit, leaseOwner],
    );
    return result.rows.map(operation);
  }

  async markReconciliationFailure(operationId: string, leaseOwner: string, code: string) {
    await this.pool.query(
      `
        update refund_operations
        set last_reconciliation_error_code = $3,
            manual_review_required = reconciliation_attempt_count >= 10,
            next_reconciliation_at = case
              when reconciliation_attempt_count >= 10 then null
              else now() + make_interval(mins => least(60, (2 ^ least(reconciliation_attempt_count, 5))::int))
            end,
            reconciliation_lease_owner = null,
            reconciliation_lease_expires_at = null
        where id = $1::uuid and reconciliation_lease_owner = $2
      `,
      [operationId, leaseOwner, code.slice(0, 128)],
    );
  }

  private async totals(client: PoolClient, orderId: string) {
    const result = await client.query<{ conflicts: number; pending: number; succeeded: number }>(
      `
        select
          coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0)::int as succeeded,
          coalesce(sum(amount_cents) filter (where status = 'pending'), 0)::int as pending,
          count(*) filter (where status = 'pending' and pending_reason = 'provider_conflict')::int as conflicts
        from refund_operations where order_id = $1::uuid
      `,
      [orderId],
    );
    return result.rows[0] ?? { conflicts: 0, pending: 0, succeeded: 0 };
  }

  private async updatePaymentStatus(
    client: PoolClient,
    orderId: string,
    captured: number,
    succeeded: number,
  ) {
    const nextStatus = succeeded <= 0
      ? "paid"
      : succeeded >= captured
        ? "refunded"
        : "partially_refunded";
    await client.query(
      `update orders set payment_status = $2::payment_status where id = $1::uuid and payment_status is distinct from $2::payment_status`,
      [orderId, nextStatus],
    );
  }
}
