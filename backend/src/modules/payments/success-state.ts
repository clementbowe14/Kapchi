import type { PoolClient, QueryResultRow } from "pg";

type QueryableClient = Pick<PoolClient, "query">;

type StripeMetadata = {
  order_id?: string | null;
};

export type CheckoutSessionCompletedPayload = {
  id: string;
  metadata?: StripeMetadata | null;
  payment_intent?: string | { id: string } | null;
};

export type PaymentIntentSucceededPayload = {
  id: string;
  metadata?: StripeMetadata | null;
};

type OrderPaymentRow = QueryResultRow & {
  id: string;
  fulfillment_status: string;
  paid_at: Date | string | null;
  payment_status: string;
  status: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

export type SuccessfulPaymentResult =
  | {
      outcome: "updated";
      orderId: string;
    }
  | {
      outcome: "already_paid" | "terminal_state" | "unknown_order";
      orderId?: string;
    };

type SuccessfulPaymentIdentifiers = {
  checkoutSessionId?: string;
  eventType: "checkout.session.completed" | "payment_intent.succeeded";
  metadataOrderId?: string | null;
  paymentIntentId?: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const terminalOrderStatuses = new Set(["cancelled", "completed", "refunded"]);
const terminalPaymentStatuses = new Set(["refunded", "partially_refunded"]);

export async function handleCheckoutSessionCompleted(
  client: QueryableClient,
  session: CheckoutSessionCompletedPayload,
) {
  return handleSuccessfulPayment(client, {
    checkoutSessionId: session.id,
    eventType: "checkout.session.completed",
    metadataOrderId: session.metadata?.order_id,
    paymentIntentId: getPaymentIntentId(session.payment_intent)
  });
}

export async function handlePaymentIntentSucceeded(
  client: QueryableClient,
  paymentIntent: PaymentIntentSucceededPayload,
) {
  return handleSuccessfulPayment(client, {
    eventType: "payment_intent.succeeded",
    metadataOrderId: paymentIntent.metadata?.order_id,
    paymentIntentId: paymentIntent.id
  });
}

async function handleSuccessfulPayment(
  client: QueryableClient,
  identifiers: SuccessfulPaymentIdentifiers,
): Promise<SuccessfulPaymentResult> {
  await client.query("begin");

  try {
    const order = await findOrderForSuccessfulPayment(client, identifiers);

    if (!order) {
      await client.query("commit");
      return { outcome: "unknown_order" };
    }

    if (order.payment_status === "paid") {
      await client.query("commit");
      return {
        outcome: "already_paid",
        orderId: order.id
      };
    }

    if (isTerminalOrderState(order)) {
      await client.query("commit");
      return {
        outcome: "terminal_state",
        orderId: order.id
      };
    }

    await markOrderPaid(client, order, identifiers);
    await insertOrderPaidEvent(client, order, identifiers);
    await client.query("commit");

    return {
      outcome: "updated",
      orderId: order.id
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function getPaymentIntentId(
  paymentIntent: CheckoutSessionCompletedPayload["payment_intent"],
) {
  if (typeof paymentIntent === "string") {
    return paymentIntent;
  }

  return paymentIntent?.id;
}

async function findOrderForSuccessfulPayment(
  client: QueryableClient,
  {
    checkoutSessionId,
    metadataOrderId,
    paymentIntentId
  }: SuccessfulPaymentIdentifiers,
) {
  const orderId =
    metadataOrderId && uuidPattern.test(metadataOrderId) ? metadataOrderId : null;

  const result = await client.query<OrderPaymentRow>(
    `
      select
        id,
        status,
        payment_status,
        fulfillment_status,
        paid_at,
        stripe_checkout_session_id,
        stripe_payment_intent_id
      from orders
      where ($1::uuid is not null and id = $1::uuid)
        or ($2::text is not null and stripe_checkout_session_id = $2::text)
        or ($3::text is not null and stripe_payment_intent_id = $3::text)
      order by
        case
          when $1::uuid is not null and id = $1::uuid then 0
          when $2::text is not null and stripe_checkout_session_id = $2::text then 1
          else 2
        end
      limit 1
      for update
    `,
    [orderId, checkoutSessionId ?? null, paymentIntentId ?? null],
  );

  return result.rows[0];
}

function isTerminalOrderState(order: OrderPaymentRow) {
  return (
    terminalOrderStatuses.has(order.status) ||
    terminalPaymentStatuses.has(order.payment_status)
  );
}

async function markOrderPaid(
  client: QueryableClient,
  order: OrderPaymentRow,
  { paymentIntentId }: SuccessfulPaymentIdentifiers,
) {
  await client.query(
    `
      update orders
      set
        payment_status = 'paid',
        status = case
          when status in ('pending_payment', 'paid') then 'paid'::order_status
          else status
        end,
        fulfillment_status = case
          when fulfillment_status in ('not_started', 'queued') then 'queued'::fulfillment_status
          else fulfillment_status
        end,
        paid_at = coalesce(paid_at, now()),
        stripe_payment_intent_id = coalesce(stripe_payment_intent_id, $2::text),
        updated_at = now()
      where id = $1::uuid
    `,
    [order.id, paymentIntentId ?? null],
  );
}

async function insertOrderPaidEvent(
  client: QueryableClient,
  order: OrderPaymentRow,
  identifiers: SuccessfulPaymentIdentifiers,
) {
  await client.query(
    `
      insert into order_events (
        order_id,
        actor_type,
        actor_id,
        event_type,
        from_value,
        to_value,
        metadata
      )
      values (
        $1::uuid,
        'stripe',
        $2::text,
        'stripe.payment_succeeded',
        $3::text,
        'paid',
        $4::jsonb
      )
    `,
    [
      order.id,
      identifiers.paymentIntentId ?? identifiers.checkoutSessionId ?? null,
      order.payment_status,
      {
        checkoutSessionId: identifiers.checkoutSessionId ?? null,
        eventType: identifiers.eventType,
        paymentIntentId: identifiers.paymentIntentId ?? null
      }
    ],
  );
}
