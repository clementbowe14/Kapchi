import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type Stripe from "stripe";
import {
  handleCheckoutSessionCompleted,
  handlePaymentIntentSucceeded
} from "../payments/success-state.js";
import type { RefundProvider } from "./provider.js";
import { RefundRepository } from "./repository.js";

type WebhookOutcome = {
  duplicate: boolean;
  processingStatus: "processed" | "retryable" | "unmatched";
};

function idOf(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

function allowlistedMetadata(metadata: Stripe.Metadata | null | undefined) {
  return {
    ...(metadata?.operation_id ? { operationId: metadata.operation_id } : {}),
    ...(metadata?.order_id ? { orderId: metadata.order_id } : {})
  };
}

export function projectStripeEvent(event: Stripe.Event) {
  const common = {
    account: event.account ?? null,
    apiVersion: event.api_version ?? null,
    created: event.created,
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
    objectId: "id" in event.data.object ? event.data.object.id : null,
    objectType: "object" in event.data.object ? event.data.object.object : null,
    projectionVersion: 1
  };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    return {
      ...common,
      kind: "checkout_session_completed",
      metadata: allowlistedMetadata(session.metadata),
      paymentIntentId: idOf(session.payment_intent),
      paymentStatus: session.payment_status,
      sessionId: session.id
    };
  }
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent;
    return {
      ...common,
      amountReceived: intent.amount_received,
      currency: intent.currency,
      kind: "payment_intent_succeeded",
      latestChargeId: idOf(intent.latest_charge),
      metadata: allowlistedMetadata(intent.metadata),
      paymentIntentId: intent.id,
      status: intent.status
    };
  }
  if (["refund.created", "refund.updated", "refund.failed"].includes(event.type)) {
    const refund = event.data.object as Stripe.Refund;
    return {
      ...common,
      amount: refund.amount,
      chargeId: idOf(refund.charge),
      currency: refund.currency,
      failureCode: refund.failure_reason ?? null,
      kind: "refund",
      metadata: allowlistedMetadata(refund.metadata),
      paymentIntentId: idOf(refund.payment_intent),
      refundId: refund.id,
      status: refund.status
    };
  }
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    return {
      ...common,
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      captured: charge.captured,
      chargeId: charge.id,
      currency: charge.currency,
      kind: "charge_refunded",
      paymentIntentId: idOf(charge.payment_intent)
    };
  }
  return { ...common, kind: "ignored" };
}

export class StripeWebhookInbox {
  private readonly repository: RefundRepository;

  constructor(
    private readonly pool: Pool,
    private readonly provider: RefundProvider,
  ) {
    this.repository = new RefundRepository(pool);
  }

  async receive(event: Stripe.Event, rawPayload: string): Promise<WebhookOutcome> {
    const projection = projectStripeEvent(event);
    const receipt = await this.pool.query<{ stripe_event_id: string }>(
      `
        insert into stripe_webhook_events (
          stripe_event_id, event_type, api_version, livemode,
          processing_status, payload, event_projection, projection_version,
          raw_payload_sha256, provider_account_id, livemode_verified,
          next_attempt_at
        ) values ($1, $2, $3, $4, 'received', null, $5::jsonb, 1, $6, $7, true, now())
        on conflict (stripe_event_id) do nothing
        returning stripe_event_id
      `,
      [
        event.id,
        event.type,
        event.api_version ?? null,
        event.livemode,
        JSON.stringify(projection),
        createHash("sha256").update(rawPayload).digest("hex"),
        event.account ?? "platform"
      ],
    );
    if (receipt.rows.length === 0) {
      const existing = await this.pool.query<{ processing_status: string }>(
        `select processing_status from stripe_webhook_events where stripe_event_id = $1`,
        [event.id],
      );
      const storedStatus = existing.rows[0]?.processing_status;
      const processingStatus = storedStatus === "processed"
        ? "processed"
        : storedStatus === "unmatched"
          ? "unmatched"
          : "retryable";
      return { duplicate: true, processingStatus };
    }

    try {
      const processingStatus = await this.process(event);
      await this.pool.query(
        `
          update stripe_webhook_events
          set processing_status = $2::stripe_webhook_processing_status,
              processed_at = case when $2 = 'processed' then now() else null end,
              next_attempt_at = case when $2 in ('retryable', 'unmatched') then now() + interval '1 minute' else null end,
              attempt_count = attempt_count + 1,
              lease_owner = null, lease_expires_at = null
          where stripe_event_id = $1
        `,
        [event.id, processingStatus],
      );
      return { duplicate: false, processingStatus };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "WEBHOOK_PROCESSING_ERROR";
      await this.pool.query(
        `
          update stripe_webhook_events
          set processing_status = 'retryable', attempt_count = attempt_count + 1,
              next_attempt_at = now() + interval '1 minute', last_error_code = $2,
              lease_owner = null, lease_expires_at = null
          where stripe_event_id = $1
        `,
        [event.id, code.slice(0, 128)],
      );
      return { duplicate: false, processingStatus: "retryable" };
    }
  }

  async runOnce(limit = 25) {
    const leaseOwner = randomUUID();
    const claimed = await this.pool.query<{
      event_projection: Record<string, unknown>;
      stripe_event_id: string;
    }>(
      `
        with eligible as (
          select id
          from stripe_webhook_events
          where processing_status in ('received', 'retryable', 'unmatched')
            and coalesce(next_attempt_at, received_at) <= now()
            and (lease_expires_at is null or lease_expires_at < clock_timestamp())
          order by coalesce(next_attempt_at, received_at), received_at
          for update skip locked
          limit $1
        )
        update stripe_webhook_events e
        set processing_status = 'processing', lease_owner = $2,
            lease_expires_at = clock_timestamp() + interval '2 minutes'
        from eligible
        where e.id = eligible.id
        returning e.stripe_event_id, e.event_projection
      `,
      [limit, leaseOwner],
    );

    let completed = 0;
    for (const row of claimed.rows) {
      try {
        const status = await this.processProjection(row.event_projection);
        await this.pool.query(
          `
            update stripe_webhook_events
            set processing_status = $2::stripe_webhook_processing_status,
                processed_at = case when $2 = 'processed' then now() else null end,
                attempt_count = attempt_count + 1,
                next_attempt_at = case when $2 in ('retryable', 'unmatched') then now() + interval '5 minutes' else null end,
                lease_owner = null, lease_expires_at = null
            where stripe_event_id = $1 and lease_owner = $3
          `,
          [row.stripe_event_id, status, leaseOwner],
        );
        if (status === "processed") completed += 1;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "WEBHOOK_PROCESSING_ERROR";
        await this.pool.query(
          `
            update stripe_webhook_events
            set processing_status = case when attempt_count >= 9 then 'exhausted'::stripe_webhook_processing_status else 'retryable'::stripe_webhook_processing_status end,
                attempt_count = attempt_count + 1,
                next_attempt_at = case when attempt_count >= 9 then null else now() + make_interval(mins => least(60, (2 ^ least(attempt_count, 5))::int)) end,
                last_error_code = $2,
                manual_review_required = attempt_count >= 9,
                lease_owner = null, lease_expires_at = null
            where stripe_event_id = $1 and lease_owner = $3
          `,
          [row.stripe_event_id, code.slice(0, 128), leaseOwner],
        );
      }
    }
    return { attempted: claimed.rows.length, completed };
  }

  private async process(event: Stripe.Event): Promise<WebhookOutcome["processingStatus"]> {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
        return "processed";
      }
      await this.withClient((client) => handleCheckoutSessionCompleted(client, session));
      return "processed";
    }
    if (event.type === "payment_intent.succeeded") {
      await this.withClient((client) =>
        handlePaymentIntentSucceeded(client, event.data.object as Stripe.PaymentIntent),
      );
      return "processed";
    }
    if (
      ["refund.created", "refund.updated", "refund.failed", "charge.refunded"].includes(
        event.type,
      )
    ) {
      const object = event.data.object as Stripe.Refund | Stripe.Charge;
      const paymentIntentId = idOf(object.payment_intent);
      if (!paymentIntentId) return "unmatched";
      const order = await this.pool.query<{ id: string }>(
        `select id from orders where stripe_payment_intent_id = $1 limit 1`,
        [paymentIntentId],
      );
      if (!order.rows[0]) return "unmatched";
      const snapshot = await this.provider.reconcilePayment(paymentIntentId);
      await this.repository.applyReconciliation(order.rows[0].id, snapshot);
      return "processed";
    }
    return "processed";
  }

  private async processProjection(
    projection: Record<string, unknown>,
  ): Promise<WebhookOutcome["processingStatus"]> {
    if (projection.kind === "checkout_session_completed") {
      if (
        projection.paymentStatus !== "paid" &&
        projection.paymentStatus !== "no_payment_required"
      ) {
        return "processed";
      }
      const metadata = projection.metadata as { orderId?: string } | undefined;
      await this.withClient((client) =>
        handleCheckoutSessionCompleted(client, {
          id: String(projection.sessionId),
          metadata: { order_id: metadata?.orderId },
          payment_intent:
            typeof projection.paymentIntentId === "string"
              ? projection.paymentIntentId
              : null
        }),
      );
      return "processed";
    }
    if (projection.kind === "payment_intent_succeeded") {
      const metadata = projection.metadata as { orderId?: string } | undefined;
      await this.withClient((client) =>
        handlePaymentIntentSucceeded(client, {
          id: String(projection.paymentIntentId),
          metadata: { order_id: metadata?.orderId }
        }),
      );
      return "processed";
    }
    if (projection.kind === "refund" || projection.kind === "charge_refunded") {
      const paymentIntentId =
        typeof projection.paymentIntentId === "string"
          ? projection.paymentIntentId
          : null;
      if (!paymentIntentId) return "unmatched";
      const order = await this.pool.query<{ id: string }>(
        `select id from orders where stripe_payment_intent_id = $1 limit 1`,
        [paymentIntentId],
      );
      if (!order.rows[0]) return "unmatched";
      const snapshot = await this.provider.reconcilePayment(paymentIntentId);
      await this.repository.applyReconciliation(order.rows[0].id, snapshot);
      return "processed";
    }
    return "processed";
  }

  private async withClient<T>(callback: (client: import("pg").PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }
}

export type StripeWebhookInboxPort = Pick<StripeWebhookInbox, "receive" | "runOnce">;
