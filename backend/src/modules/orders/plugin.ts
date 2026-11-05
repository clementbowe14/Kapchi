import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import type { Pool } from "pg";
import { getDatabasePool } from "../../database/index.js";
import { authMiddleware, requireAuth } from "../auth/index.js";
import {
  serializePolicySnapshot,
  type CustomerPolicySnapshot,
  type PersistedPolicyAssertionRow
} from "../policies/policy-contract.js";
import { loadCustomerTracking, type CustomerTracking } from "./customer-tracking.js";

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
  policySnapshot: CustomerPolicySnapshot | null;
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

const LOOKUP_RATE_LIMIT = 10;
const LOOKUP_RATE_WINDOW_MS = 15 * 60 * 1000;
const lookupRateLimitScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

type LookupRateLimitStore = {
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<unknown>;
};

export type OrdersPluginDependencies = {
  pool?: Pick<Pool, "query">;
  rateLimitStore?: LookupRateLimitStore;
};

function lookupRateLimitKey(source: string) {
  const digest = createHash("sha256").update(source).digest("hex");
  return `order-lookup:source:${digest}`;
}

async function consumeLookupAttempt(store: LookupRateLimitStore, source: string) {
  const value = await store.eval(lookupRateLimitScript, {
    arguments: [String(LOOKUP_RATE_WINDOW_MS)],
    keys: [lookupRateLimitKey(source)]
  });
  return Number(value) <= LOOKUP_RATE_LIMIT;
}

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
  trackingByOrderId: Map<string, CustomerTracking>,
  policyByOrderId: Map<string, CustomerPolicySnapshot>,
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
    policySnapshot: policyByOrderId.get(order.id) ?? null,
    items: (itemsByOrderId.get(order.id) ?? []).map(serializeOrderItem),
    tracking: trackingByOrderId.get(order.id) ?? null
  };
}

async function loadPolicySnapshots(pool: Pick<Pool, "query">, orderIds: string[]) {
  if (orderIds.length === 0) {
    return new Map<string, CustomerPolicySnapshot>();
  }

  const result = await pool.query<PersistedPolicyAssertionRow & { order_id: string }>(
    `
      select
        order_id,
        schema_version,
        bundle_version,
        effective_date,
        checkout_statement_version,
        checkout_statement_digest,
        documents,
        assertions,
        statement_submitted_at
      from order_policy_assertions
      where order_id = any($1::uuid[])
    `,
    [orderIds],
  );

  return new Map(
    result.rows.map((row) => [row.order_id, serializePolicySnapshot(row)!]),
  );
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

async function loadOrderItems(pool: Pick<Pool, "query">, orderIds: string[]) {
  if (orderIds.length === 0) {
    return [];
  }

  const result = await pool.query<OrderItemRow>(
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

export function createOrdersPlugin(dependencies: OrdersPluginDependencies = {}) {
  const ordersPlugin: FastifyPluginAsync = async (fastify) => {
    const pool = dependencies.pool ?? getDatabasePool();
    const rateLimitStore = dependencies.rateLimitStore
      ?? ("redis" in fastify ? fastify.redis as LookupRateLimitStore : undefined);

    fastify.post("/orders/lookup", async (request, reply) => {
    if (rateLimitStore) {
      try {
        const allowed = await consumeLookupAttempt(rateLimitStore, request.ip);
        if (!allowed) {
          request.log.warn(
            { event: "order.lookup.rate_limited", resultCode: "RATE_LIMITED" },
            "Order lookup rate limited",
          );
          reply.header("retry-after", String(Math.ceil(LOOKUP_RATE_WINDOW_MS / 1000)));
          return reply.code(429).send({
            error: "ORDER_LOOKUP_UNAVAILABLE",
            message: "Order lookup is temporarily unavailable.",
            statusCode: 429
          });
        }
      } catch {
        request.log.error(
          { event: "order.lookup.rate_limit_failed", resultCode: "STORE_UNAVAILABLE" },
          "Order lookup rate limiter unavailable",
        );
        reply.header("retry-after", "60");
        return reply.code(503).send({
          error: "ORDER_LOOKUP_UNAVAILABLE",
          message: "Order lookup is temporarily unavailable.",
          statusCode: 503
        });
      }
    }

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

    const orderResult = await pool.query<OrderRow>(
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

    const items = await loadOrderItems(pool, [order.id]);
    const tracking = await loadCustomerTracking(pool, [order.id]);
    const policies = await loadPolicySnapshots(pool, [order.id]);

    return serializeOrder(order, groupItemsByOrderId(items), tracking, policies);
    });

    fastify.get(
    "/orders/me",
    {
      preHandler: [authMiddleware, requireAuth]
    },
    async (request) => {
      const orderResult = await pool.query<OrderRow>(
        `
          select ${orderSelectColumns}
          from orders
          where user_id = $1
          order by created_at desc, id desc
        `,
        [request.auth?.userId],
      );

      const orderIds = orderResult.rows.map((order) => order.id);
      const items = await loadOrderItems(pool, orderIds);
      const itemsByOrderId = groupItemsByOrderId(items);
      const trackingByOrderId = await loadCustomerTracking(pool, orderIds);
      const policyByOrderId = await loadPolicySnapshots(pool, orderIds);

      return {
        orders: orderResult.rows.map((order) =>
          serializeOrder(order, itemsByOrderId, trackingByOrderId, policyByOrderId),
        )
      };
    },
    );
  };

  return fp(ordersPlugin, { name: "orders-module" });
}

export default createOrdersPlugin();
