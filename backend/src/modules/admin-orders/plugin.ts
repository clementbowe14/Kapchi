import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import { adminRoute } from "../admin-auth/index.js";
import { AdminOrderError } from "./errors.js";
import {
  AdminOrderRepository,
  type AdminOrderReader
} from "./repository.js";
import type {
  AdminOrderSearchQuery,
  AdminOrderTimelineQuery
} from "./types.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maximumRangeDays = 366;

const orderParams = Joi.object({ orderId: uuid.required() }).required();
const searchQuery = Joi.object<AdminOrderSearchQuery>({
  createdFrom: Joi.string().pattern(datePattern).optional(),
  createdTo: Joi.string().pattern(datePattern).optional(),
  cursor: Joi.string().trim().max(1000).optional(),
  discountedOnly: Joi.boolean().default(false),
  fabricId: uuid.optional(),
  fulfillmentStatus: Joi.string().valid(
    "not_started",
    "queued",
    "in_progress",
    "ready_to_ship",
    "shipped",
    "delivered",
    "cancelled",
  ).optional(),
  lifecycle: Joi.string().valid("ongoing", "completed", "cancelled", "all").default("ongoing"),
  limit: Joi.number().integer().min(1).max(100).default(25),
  listingId: uuid.optional(),
  orderStatus: Joi.string().valid(
    "pending_payment",
    "paid",
    "in_production",
    "ready_to_ship",
    "shipped",
    "completed",
    "cancelled",
    "refunded",
  ).optional(),
  paidOnly: Joi.boolean().default(false),
  paymentStatus: Joi.string().valid(
    "unpaid",
    "checkout_started",
    "paid",
    "failed",
    "refunded",
    "partially_refunded",
  ).optional(),
  refundedOnly: Joi.boolean().default(false),
  search: Joi.string().trim().min(1).max(100).optional(),
  sort: Joi.string().valid("created_asc", "created_desc").default("created_desc")
}).required();
const timelineQuery = Joi.object<AdminOrderTimelineQuery>({
  cursor: Joi.string().trim().max(1000).optional(),
  limit: Joi.number().integer().min(1).max(100).default(50)
}).required();

function day(value: string) {
  const [year, month, date] = value.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, date));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== date
  ) return null;
  return Math.floor(instant.getTime() / 86_400_000);
}

function validateDates(query: AdminOrderSearchQuery) {
  const start = query.createdFrom ? day(query.createdFrom) : null;
  const end = query.createdTo ? day(query.createdTo) : null;
  if (query.createdFrom && start === null) return "createdFrom must be a real calendar date.";
  if (query.createdTo && end === null) return "createdTo must be a real calendar date.";
  if (start !== null && end !== null && end < start) {
    return "createdTo must be on or after createdFrom.";
  }
  if (start !== null && end !== null && end - start + 1 > maximumRangeDays) {
    return `Order date ranges cannot exceed ${maximumRangeDays} inclusive days.`;
  }
  return null;
}

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    message,
    statusCode: 400
  });
}

function unavailable(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String(error.code);
  return code === "ECONNREFUSED"
    || code === "ETIMEDOUT"
    || code.startsWith("08")
    || code === "53300"
    || code === "57P01"
    || code === "57P02"
    || code === "57P03";
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminOrderError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      statusCode: error.statusCode
    });
  }
  if (unavailable(error)) {
    reply.header("retry-after", "30");
    return reply.code(503).send({
      error: "ADMIN_ORDERS_UNAVAILABLE",
      message: "Admin order data is temporarily unavailable.",
      statusCode: 503
    });
  }
  throw error;
}

export type AdminOrderPluginDependencies = {
  repository?: AdminOrderReader;
};

export function createAdminOrderPlugin(
  dependencies: AdminOrderPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const repository = dependencies.repository ?? new AdminOrderRepository(fastify.pg);

    fastify.get(
      "/",
      adminRoute("orders:read"),
      async (request, reply) => {
        const parsed = searchQuery.validate(request.query, {
          abortEarly: false,
          allowUnknown: false
        });
        if (parsed.error) return validationError(reply, parsed.error.message);
        const dateError = validateDates(parsed.value);
        if (dateError) return validationError(reply, dateError);
        try {
          const result = await repository.search(parsed.value);
          request.log.info(
            {
              event: "admin.orders.search.completed",
              hasNextPage: result.nextCursor !== null,
              lifecycle: parsed.value.lifecycle,
              resultCount: result.orders.length,
              sort: parsed.value.sort
            },
            "Admin order search completed",
          );
          return result;
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.get<{ Params: { orderId: string } }>(
      "/:orderId/timeline",
      adminRoute("orders:read"),
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        const query = timelineQuery.validate(request.query, {
          abortEarly: false,
          allowUnknown: false
        });
        if (params.error || query.error) {
          return validationError(reply, params.error?.message ?? query.error!.message);
        }
        try {
          const result = await repository.timeline(params.value.orderId, query.value);
          request.log.info(
            {
              entryCount: result.entries.length,
              event: "admin.orders.timeline.completed",
              hasNextPage: result.nextCursor !== null,
              orderId: params.value.orderId
            },
            "Admin order timeline completed",
          );
          return result;
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.get<{ Params: { orderId: string } }>(
      "/:orderId",
      adminRoute("orders:read"),
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        if (params.error) return validationError(reply, params.error.message);
        try {
          const result = await repository.detail(params.value.orderId);
          request.log.info(
            {
              event: "admin.orders.detail.completed",
              itemCount: result.itemCount,
              orderId: result.id
            },
            "Admin order detail completed",
          );
          return result;
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  };

  return fp(plugin, { encapsulate: true, name: "admin-orders-plugin" });
}

export default createAdminOrderPlugin();
