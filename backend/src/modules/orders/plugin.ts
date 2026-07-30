import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import { getDatabasePool } from "../../database/index.js";
import { authMiddleware, requireAuth } from "../auth/index.js";

type OrderRow = {
  id: string;
  public_order_number: string;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  customer_email: string | null;
  customer_phone: string | null;
  total_cents: number;
  currency: string;
  created_at: Date | string;
  paid_at: Date | string | null;
};

type OrderItemRow = {
  asset_byte_size: number | null;
  asset_content_type: string | null;
  asset_id: string | null;
  asset_provider: string | null;
  asset_visibility: string | null;
  id: string;
  order_id: string;
  quantity: number;
  unit_amount_cents: number;
  total_amount_cents: number;
  currency: string;
  listing_snapshot: unknown;
  fabric_snapshot: unknown | null;
  customization_snapshot: unknown;
};

type CustomerSafeOrder = {
  id: string;
  publicOrderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  totalCents: number;
  currency: string;
  createdAt: string;
  paidAt?: string | null;
  items: CustomerSafeOrderItem[];
  tracking?: {
    carrier?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
  } | null;
};

type CustomerSafeOrderItem = {
  customizationAsset?: {
    byteSize: number;
    contentType: string;
    id: string;
    provider: string;
    visibility: string;
  };
  id: string;
  quantity: number;
  unitAmountCents: number;
  totalAmountCents: number;
  currency: string;
  listingSnapshot: unknown;
  fabricSnapshot?: unknown;
  customizationSummary: unknown;
};

const lookupSchema = Joi.object({
  orderId: Joi.string().trim().min(1).max(128).required(),
  email: Joi.string().trim().email().optional(),
  phone: Joi.string().trim().min(3).max(64).optional()
})
  .or("email", "phone")
  .required();

const orderSelectColumns = `
  id,
  public_order_number,
  status,
  payment_status,
  fulfillment_status,
  customer_email,
  customer_phone,
  total_cents,
  currency,
  created_at,
  paid_at
`;

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    message,
    statusCode: 400
  });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: "ORDER_NOT_FOUND",
    message: "Order not found.",
    statusCode: 404
  });
}

function normalizeEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() ?? "";
}

function normalizePhone(phone: string | null | undefined) {
  return phone?.replace(/\D/g, "") ?? "";
}

function datestring(value: Date | string | null) {
  if (value === null) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function contactMatches(
  order: OrderRow,
  contact: { email?: string; phone?: string },
) {
  const emailMatches =
    contact.email !== undefined &&
    normalizeEmail(contact.email) === normalizeEmail(order.customer_email);
  const phoneMatches =
    contact.phone !== undefined &&
    normalizePhone(contact.phone).length > 0 &&
    normalizePhone(contact.phone) === normalizePhone(order.customer_phone);

  return emailMatches || phoneMatches;
}

function serializeOrderItem(item: OrderItemRow): CustomerSafeOrderItem {
  return {
    id: item.id,
    quantity: item.quantity,
    unitAmountCents: item.unit_amount_cents,
    totalAmountCents: item.total_amount_cents,
    currency: item.currency,
    listingSnapshot: item.listing_snapshot,
    ...(item.fabric_snapshot === null ? {} : { fabricSnapshot: item.fabric_snapshot }),
    customizationSummary: item.customization_snapshot,
    ...(item.asset_id &&
    item.asset_provider &&
    item.asset_content_type &&
    typeof item.asset_byte_size === "number" &&
    item.asset_visibility
      ? {
          customizationAsset: {
            byteSize: item.asset_byte_size,
            contentType: item.asset_content_type,
            id: item.asset_id,
            provider: item.asset_provider,
            visibility: item.asset_visibility
          }
        }
      : {})
  };
}

function serializeOrder(
  order: OrderRow,
  itemsByOrderId: Map<string, OrderItemRow[]>,
): CustomerSafeOrder {
  return {
    id: order.id,
    publicOrderNumber: order.public_order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    fulfillmentStatus: order.fulfillment_status,
    customerEmail: order.customer_email,
    customerPhone: order.customer_phone,
    totalCents: order.total_cents,
    currency: order.currency,
    createdAt: datestring(order.created_at) ?? "",
    paidAt: datestring(order.paid_at),
    items: (itemsByOrderId.get(order.id) ?? []).map(serializeOrderItem),
    tracking: null
  };
}

function groupItemsByOrderId(items: OrderItemRow[]) {
  const grouped = new Map<string, OrderItemRow[]>();

  for (const item of items) {
    const orderItems = grouped.get(item.order_id) ?? [];
    orderItems.push(item);
    grouped.set(item.order_id, orderItems);
  }

  return grouped;
}

async function loadOrderItems(orderIds: string[]) {
  if (orderIds.length === 0) {
    return [];
  }

  const result = await getDatabasePool().query<OrderItemRow>(
    `
      select
        oi.id,
        oi.order_id,
        oi.quantity,
        oi.unit_amount_cents,
        oi.total_amount_cents,
        oi.currency,
        oi.listing_snapshot,
        oi.fabric_snapshot,
        oi.customization_snapshot,
        a.id as asset_id,
        a.provider as asset_provider,
        a.content_type as asset_content_type,
        a.byte_size as asset_byte_size,
        a.visibility as asset_visibility
      from order_items oi
      left join assets a on a.id = oi.customization_asset_id
      where oi.order_id = any($1::uuid[])
      order by oi.created_at asc, oi.id asc
    `,
    [orderIds],
  );

  return result.rows;
}

const ordersPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post("/orders/lookup", async (request, reply) => {
    const { error, value } = lookupSchema.validate(request.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      return badRequest(reply, error.message);
    }

    const contact = value as {
      email?: string;
      orderId: string;
      phone?: string;
    };

    const orderResult = await getDatabasePool().query<OrderRow>(
      `
        select ${orderSelectColumns}
        from orders
        where public_order_number = $1
        limit 1
      `,
      [contact.orderId],
    );

    const order = orderResult.rows[0];

    if (!order || !contactMatches(order, contact)) {
      return notFound(reply);
    }

    const items = await loadOrderItems([order.id]);

    return serializeOrder(order, groupItemsByOrderId(items));
  });

  fastify.get(
    "/orders/me",
    {
      preHandler: [authMiddleware, requireAuth]
    },
    async (request) => {
      const orderResult = await getDatabasePool().query<OrderRow>(
        `
          select ${orderSelectColumns}
          from orders
          where user_id = $1
          order by created_at desc, id desc
        `,
        [request.auth?.userId],
      );

      const orderIds = orderResult.rows.map((order) => order.id);
      const items = await loadOrderItems(orderIds);
      const itemsByOrderId = groupItemsByOrderId(items);

      return {
        orders: orderResult.rows.map((order) => serializeOrder(order, itemsByOrderId))
      };
    },
  );
};

export default fp(ordersPlugin, {
  name: "orders-module"
});
