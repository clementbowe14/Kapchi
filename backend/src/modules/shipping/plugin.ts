import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import Joi from "joi";
import { adminRoute } from "../admin-auth/index.js";
import { ShippingExportError } from "./errors.js";
import {
  addressCorrectionFingerprint,
  batchMutationFingerprint,
  exportFingerprint,
  ShippingExportRepository,
  type ShippingExportRepositoryPort
} from "./repository.js";
import type { AddressCorrectionInput, ExportOrderInput } from "./types.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const printable = /^[\x20-\x7e]+$/;
const noControls = /^[^\u0000-\u001f\u007f]*$/;
function decimalMeasurement(maximum: number) {
  return Joi.number().positive().max(maximum).custom((value: number, helpers) =>
    Number(value.toFixed(2)) === value
      ? value
      : helpers.error("number.precision", { limit: 2 }),
  );
}
const packageSchema = Joi.object({
  description: Joi.string().trim().empty("").max(120).pattern(noControls).optional(),
  heightInches: decimalMeasurement(120).required(),
  lengthInches: decimalMeasurement(120).required(),
  weightOunces: decimalMeasurement(2400).required(),
  widthInches: decimalMeasurement(120).required()
}).required();
const exportRowSchema = Joi.object<ExportOrderInput>({
  expectedRevision: Joi.number().integer().min(0).required(),
  orderId: uuid.required(),
  package: packageSchema
}).required();
const candidateBody = Joi.object({
  orderIds: Joi.array().items(uuid.required()).min(1).max(100).unique().required()
}).required();
const createBody = Joi.object({
  orders: Joi.array().items(exportRowSchema).min(1).max(100)
    .unique("orderId").required()
}).required();
const batchParams = Joi.object({ batchId: uuid.required() }).required();
const orderParams = Joi.object({ orderId: uuid.required() }).required();
const listQuery = Joi.object({
  cursor: uuid.optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  status: Joi.string().trim().default("prepared,expired")
}).required();
const batchMutationBody = Joi.object({
  expectedStatus: Joi.string().valid("prepared", "expired").required(),
  intent: Joi.string().valid("no_label_purchased").required(),
  reason: Joi.string().trim().min(3).max(500).pattern(noControls).required()
}).required();
const addressSchema = Joi.object({
  city: Joi.string().trim().min(1).max(100).required(),
  country: Joi.string().trim().uppercase().valid("US").required(),
  line1: Joi.string().trim().min(1).max(128).required(),
  line2: Joi.string().trim().empty("").max(128).optional(),
  postalCode: Joi.string().trim().pattern(/^\d{5}(?:-\d{4})?$/).required(),
  state: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/).required()
}).required();
const addressCorrectionBody = Joi.object<AddressCorrectionInput>({
  address: addressSchema,
  expectedRevision: Joi.number().integer().min(0).required(),
  intent: Joi.string().valid("correct_shipping_address").required(),
  name: Joi.string().trim().min(1).max(100).pattern(noControls).required(),
  reason: Joi.string().trim().min(3).max(500).pattern(noControls).required()
}).required();

function validationError(reply: FastifyReply, field?: string) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    ...(field ? { fields: [field] } : {}),
    message: "The shipping export request is invalid.",
    statusCode: 400
  });
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 16 || value.length > 128 || !printable.test(value)) {
    validationError(reply, "Idempotency-Key");
    return null;
  }
  return value;
}

function unavailable(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code);
  return code === "ECONNREFUSED" || code === "ETIMEDOUT" || code.startsWith("08") ||
    ["53300", "57P01", "57P02", "57P03"].includes(code);
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ShippingExportError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      ...(error.details ? { details: error.details } : {}),
      message: error.message,
      statusCode: error.statusCode
    });
  }
  if (unavailable(error)) {
    reply.header("retry-after", "30");
    return reply.code(503).send({
      error: "SHIPPING_EXPORT_UNAVAILABLE",
      message: "Shipping exports are temporarily unavailable.",
      statusCode: 503
    });
  }
  throw error;
}

export type ShippingPluginDependencies = { repository?: ShippingExportRepositoryPort };

export function createShippingPlugin(dependencies: ShippingPluginDependencies = {}) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const repository = dependencies.repository ?? new ShippingExportRepository(fastify.pg);

    async function actorFor(request: FastifyRequest, reply: FastifyReply) {
      const actor = await repository.resolveActor(request.auth!.userId);
      if (!actor) {
        reply.code(403).send({
          error: "ORDER_ACTOR_UNAVAILABLE",
          message: "A verified active administrator profile is required.",
          statusCode: 403
        });
        return null;
      }
      return actor;
    }

    fastify.post("/shipping/export-candidates", adminRoute("fulfillment:write"), async (request, reply) => {
      const parsed = candidateBody.validate(request.body, { abortEarly: false, allowUnknown: false });
      if (parsed.error) return validationError(reply);
      const actor = await actorFor(request, reply);
      if (!actor) return;
      try {
        const result = await repository.preflight(parsed.value.orderIds);
        request.log.info({
          actorUserId: actor.userId,
          candidateCount: parsed.value.orderIds.length,
          eligibleCount: result.candidates.filter((row) => row.eligible).length,
          event: "shipping.export.preflight.completed"
        }, "Shipping export preflight completed");
        return result;
      } catch (error) {
        return sendError(reply, error);
      }
    });

    fastify.post("/shipping/export-batches", adminRoute("fulfillment:write"), async (request, reply) => {
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const parsed = createBody.validate(request.body, { abortEarly: false, allowUnknown: false });
      if (parsed.error) return validationError(reply);
      const actor = await actorFor(request, reply);
      if (!actor) return;
      const fingerprint = exportFingerprint(parsed.value.orders);
      try {
        const result = await repository.createBatch(actor, parsed.value.orders, key, fingerprint, request.id);
        request.log.info({
          actorUserId: actor.userId,
          batchId: result.batchId,
          event: result.replayed ? "shipping.export.batch.replayed" : "shipping.export.batch.created",
          fileSha256: result.fileSha256,
          mappingVersion: result.mappingVersion,
          replayed: result.replayed,
          rowCount: result.rowCount
        }, "Shipping export batch prepared");
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        request.log.warn({
          event: "shipping.export.batch.rejected",
          errorCode: error instanceof ShippingExportError ? error.code : "SHIPPING_EXPORT_UNAVAILABLE",
          rowCount: parsed.value.orders.length
        }, "Shipping export batch rejected");
        return sendError(reply, error);
      }
    });

    fastify.get("/shipping/export-batches", adminRoute("fulfillment:write"), async (request, reply) => {
      const parsed = listQuery.validate(request.query, { abortEarly: false, allowUnknown: false });
      if (parsed.error) return validationError(reply);
      const statuses = String(parsed.value.status).split(",").map((value) => value.trim());
      if (statuses.some((status) => !["prepared", "expired", "cancelled"].includes(status))) {
        return validationError(reply, "status");
      }
      const actor = await actorFor(request, reply);
      if (!actor) return;
      try {
        return await repository.list(statuses, parsed.value.cursor, parsed.value.limit);
      } catch (error) {
        return sendError(reply, error);
      }
    });

    fastify.get("/shipping/export-batches/:batchId", adminRoute("fulfillment:write"), async (request, reply) => {
      const parsed = batchParams.validate(request.params, { allowUnknown: false });
      if (parsed.error) return validationError(reply);
      const actor = await actorFor(request, reply);
      if (!actor) return;
      try {
        return await repository.detail(parsed.value.batchId);
      } catch (error) {
        return sendError(reply, error);
      }
    });

    fastify.get("/shipping/export-batches/:batchId/file", adminRoute("fulfillment:write"), async (request, reply) => {
      const parsed = batchParams.validate(request.params, { allowUnknown: false });
      if (parsed.error) return validationError(reply);
      const actor = await actorFor(request, reply);
      if (!actor) return;
      try {
        const result = await repository.download(parsed.value.batchId);
        request.log.info({
          actorUserId: actor.userId,
          batchId: parsed.value.batchId,
          event: "shipping.export.file.issued",
          fileSha256: result.sha256
        }, "Shipping export file issued");
        return reply
          .header("cache-control", "private, no-store")
          .header("content-disposition", `attachment; filename="${result.filename}"`)
          .header("content-type", "text/csv; charset=utf-8")
          .header("x-content-type-options", "nosniff")
          .send(result.bytes);
      } catch (error) {
        request.log.warn({
          batchId: parsed.value.batchId,
          errorCode: error instanceof ShippingExportError ? error.code : "SHIPPING_EXPORT_UNAVAILABLE",
          event: "shipping.export.file.issue_failed"
        }, "Shipping export file issue failed");
        return sendError(reply, error);
      }
    });

    for (const command of ["cancel", "release"] as const) {
      fastify.post(`/shipping/export-batches/:batchId/${command}`, adminRoute("fulfillment:write"), async (request, reply) => {
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const params = batchParams.validate(request.params, { allowUnknown: false });
        const body = batchMutationBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) return validationError(reply);
        const expectedStatus = command === "cancel" ? "prepared" : "expired";
        if (body.value.expectedStatus !== expectedStatus) return validationError(reply, "expectedStatus");
        const actor = await actorFor(request, reply);
        if (!actor) return;
        const fingerprint = batchMutationFingerprint(command, params.value.batchId, body.value);
        try {
          const result = await repository.mutateBatch(
            command, params.value.batchId, actor, body.value, key, fingerprint, request.id,
          );
          request.log.info({
            actorUserId: actor.userId,
            batchId: params.value.batchId,
            event: `shipping.export.batch.${command === "cancel" ? "cancelled" : "released"}`,
            replayed: result.replayed
          }, "Shipping export batch mutation completed");
          return result;
        } catch (error) {
          return sendError(reply, error);
        }
      });
    }

    fastify.post("/orders/:orderId/actions/correct-shipping-address", adminRoute("fulfillment:write"), async (request, reply) => {
      const key = idempotencyKey(request, reply);
      if (!key) return;
      const params = orderParams.validate(request.params, { allowUnknown: false });
      const body = addressCorrectionBody.validate(request.body, { abortEarly: false, allowUnknown: false });
      if (params.error || body.error) return validationError(reply);
      const actor = await actorFor(request, reply);
      if (!actor) return;
      try {
        const result = await repository.correctAddress(
          params.value.orderId,
          actor,
          body.value,
          key,
          addressCorrectionFingerprint(params.value.orderId, body.value),
        );
        request.log.info({
          actorUserId: actor.userId,
          event: "shipping.address.corrected",
          orderId: params.value.orderId,
          replayed: result.replayed,
          revision: "revision" in result ? result.revision : undefined
        }, "Shipping address corrected");
        return result;
      } catch (error) {
        return sendError(reply, error);
      }
    });
  };

  return fp(plugin, { encapsulate: true, name: "shipping-module" });
}

export default createShippingPlugin();
