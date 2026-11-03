import type { PoolClient, QueryResultRow } from "pg";

type QueryableClient = Pick<PoolClient, "query">;

type StripeMetadata = {
  order_id?: string | null;
};

export type CheckoutSessionCompletedPayload = {
  collected_information?: {
    shipping_details?: StripeShippingDetails | null;
  } | null;
  id: string;
  metadata?: StripeMetadata | null;
  payment_intent?: string | { id: string } | null;
  shipping?: ShippingProjection | null;
  shipping_details?: StripeShippingDetails | null;
};

type StripeShippingDetails = {
  address?: {
    city?: string | null;
    country?: string | null;
    line1?: string | null;
    line2?: string | null;
    postal_code?: string | null;
    state?: string | null;
  } | null;
  name?: string | null;
};

export type ShippingProjection = {
  address?: {
    city: string;
    country: "US";
    line1: string;
    line2?: string;
    postalCode: string;
    state: string;
  };
  issueCode?: "ADDRESS_INCOMPLETE" | "ADDRESS_INVALID" | "ADDRESS_MISSING" | "ADDRESS_UNSUPPORTED_COUNTRY";
  name?: string;
  status: "invalid" | "missing" | "valid";
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
  shipping?: ShippingProjection;
};

type FabricOrderItemRow = QueryResultRow & {
  fabric_id: string;
  order_item_id: string;
  quantity: number;
};

type FabricReservationRow = QueryResultRow & {
  fabric_id: string;
  order_item_id: string;
  quantity: number;
  reservation_id: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const terminalOrderStatuses = new Set(["cancelled", "completed", "refunded"]);
const terminalPaymentStatuses = new Set(["refunded", "partially_refunded"]);

export async function handleCheckoutSessionCompleted(
  client: QueryableClient,
  session: CheckoutSessionCompletedPayload,
) {
  const hasShippingProjection = session.shipping !== undefined ||
    session.collected_information !== undefined ||
    session.shipping_details !== undefined;
  return handleSuccessfulPayment(client, {
    checkoutSessionId: session.id,
    eventType: "checkout.session.completed",
    metadataOrderId: session.metadata?.order_id,
    paymentIntentId: getPaymentIntentId(session.payment_intent),
    ...(hasShippingProjection ? {
      shipping: session.shipping ?? normalizeStripeShippingDetails(
        session.collected_information?.shipping_details ?? session.shipping_details,
      )
    } : {})
  });
}

function normalized(value: string | null | undefined) {
  return value?.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim() ?? "";
}

export function normalizeStripeShippingDetails(
  details: StripeShippingDetails | null | undefined,
): ShippingProjection {
  if (!details) return { issueCode: "ADDRESS_MISSING", status: "missing" };
  const name = normalized(details.name);
  const source = details.address;
  if (!source) return { issueCode: "ADDRESS_MISSING", status: "missing" };
  const country = normalized(source.country).toUpperCase();
  if (country && country !== "US") {
    return { issueCode: "ADDRESS_UNSUPPORTED_COUNTRY", status: "invalid" };
  }
  const address = {
    city: normalized(source.city),
    country: "US" as const,
    line1: normalized(source.line1),
    line2: normalized(source.line2),
    postalCode: normalized(source.postal_code),
    state: normalized(source.state).toUpperCase()
  };
  if (!name || !address.line1 || !address.city || !address.state || !address.postalCode) {
    return { issueCode: "ADDRESS_INCOMPLETE", status: "invalid" };
  }
  if (!/^[A-Z]{2}$/.test(address.state) || !/^\d{5}(?:-\d{4})?$/.test(address.postalCode)) {
    return { issueCode: "ADDRESS_INVALID", status: "invalid" };
  }
  return {
    address: {
      city: address.city,
      country: "US",
      line1: address.line1,
      ...(address.line2 ? { line2: address.line2 } : {}),
      postalCode: address.postalCode,
      state: address.state
    },
    name,
    status: "valid"
  };
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

    if (identifiers.eventType === "checkout.session.completed" && identifiers.shipping) {
      await applyShippingProjection(client, order, identifiers);
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

    await consumeFabricInventory(client, order.id);
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

async function applyShippingProjection(
  client: QueryableClient,
  order: OrderPaymentRow,
  identifiers: SuccessfulPaymentIdentifiers,
) {
  const shipping = identifiers.shipping!;
  if (shipping.status === "valid" && shipping.address && shipping.name) {
    await client.query(
      `update orders
       set shipping_name = $2,
           shipping_address = $3::jsonb,
           shipping_address_status = 'valid',
           shipping_address_issue_code = null,
           updated_at = now()
       where id = $1::uuid and stripe_checkout_session_id = $4`,
      [order.id, shipping.name, JSON.stringify(shipping.address), identifiers.checkoutSessionId],
    );
    return;
  }
  await client.query(
    `update orders
     set shipping_address_status = $2,
         shipping_address_issue_code = $3,
         updated_at = now()
     where id = $1::uuid and shipping_address is null
       and stripe_checkout_session_id = $4`,
    [order.id, shipping.status, shipping.issueCode ?? "ADDRESS_INVALID", identifiers.checkoutSessionId],
  );
}

export async function consumeFabricInventory(
  client: QueryableClient,
  orderId: string,
) {
  const items = await client.query<FabricOrderItemRow>(
    `
      select oi.id as order_item_id, oi.fabric_id, oi.quantity
      from order_items oi
      join fabrics f on f.id = oi.fabric_id
      where oi.order_id = $1::uuid and oi.fabric_id is not null
      order by oi.fabric_id, oi.id
      for update of oi, f
    `,
    [orderId],
  );
  const reservations = await client.query<FabricReservationRow>(
    `
      select
        fr.id as reservation_id,
        fr.fabric_id,
        fr.order_item_id,
        fr.quantity
      from fabric_reservations fr
      where fr.order_id = $1::uuid
        and fr.status = 'active'
      order by fr.fabric_id, fr.order_item_id, fr.id
      for update
    `,
    [orderId],
  );
  const reservationByItem = new Map(
    reservations.rows.map((reservation) => [reservation.order_item_id, reservation]),
  );
  const totals = new Map<string, number>();

  for (const item of items.rows) {
    const reservation = reservationByItem.get(item.order_item_id);
    if (
      !reservation ||
      reservation.fabric_id !== item.fabric_id ||
      reservation.quantity !== item.quantity
    ) {
      throw new Error("Fabric reservation does not match the paid order item.");
    }
    totals.set(item.fabric_id, (totals.get(item.fabric_id) ?? 0) + item.quantity);
  }
  if (reservations.rows.length !== items.rows.length) {
    throw new Error("Paid order has conflicting fabric reservations.");
  }
  if (items.rows.length === 0) return;

  for (const [fabricId, quantity] of totals) {
    const updated = await client.query<{ id: string }>(
      `
        update fabrics
        set quantity_on_hand = quantity_on_hand - $2,
            quantity_reserved = quantity_reserved - $2,
            quantity_sold = quantity_sold + $2
        where id = $1::uuid
          and quantity_on_hand >= $2
          and quantity_reserved >= $2
        returning id
      `,
      [fabricId, quantity],
    );
    if (updated.rows.length !== 1) {
      throw new Error("Fabric inventory changed before payment could be recorded.");
    }
  }

  const converted = await client.query<{ id: string }>(
    `
      update fabric_reservations
      set status = 'converted', expires_at = now()
      where id = any($1::uuid[]) and status = 'active'
      returning id
    `,
    [reservations.rows.map((reservation) => reservation.reservation_id)],
  );
  if (converted.rows.length !== reservations.rows.length) {
    throw new Error("Fabric reservations changed before payment could be recorded.");
  }

  for (const item of items.rows) {
    await client.query(
      `
        insert into fabric_inventory_events (
          fabric_id, order_item_id, event_type, source, idempotency_key,
          request_fingerprint, delta_on_hand, delta_sold, reason, metadata
        ) values (
          $1::uuid, $2::uuid, 'payment_consumed', 'system', $3, $4,
          $5, $6, 'Stripe payment succeeded', $7::jsonb
        )
        on conflict (idempotency_key) do nothing
      `,
      [
        item.fabric_id,
        item.order_item_id,
        `payment-consume:${item.order_item_id}`,
        `order:${orderId}:item:${item.order_item_id}:quantity:${item.quantity}`,
        -item.quantity,
        item.quantity,
        JSON.stringify({ orderId })
      ],
    );
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
        fulfillment_queued_at = case
          when fulfillment_status in ('not_started', 'queued')
            then coalesce(fulfillment_queued_at, now())
          else fulfillment_queued_at
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
