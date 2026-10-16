import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import Joi from "joi";
import { adminRoute } from "../admin-auth/index.js";
import { InventoryError } from "./errors.js";
import {
  AdminInventoryRepository,
  inventoryRequestFingerprint,
  type AdminInventoryReader
} from "./repository.js";
import type {
  FabricAdjustmentInput,
  FabricCreateInput,
  FabricListingLinkInput,
  FabricRestockInput,
  FabricUpdateInput,
  InventoryActor,
  InventoryListQuery
} from "./types.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const fabricParams = Joi.object({ fabricId: uuid.required() }).required();
const listingParams = Joi.object({
  fabricId: uuid.required(),
  listingId: uuid.required()
}).required();
const listQuery = Joi.object<InventoryListQuery>({
  fabricId: uuid.optional(),
  listingId: uuid.optional(),
  lowStockThreshold: Joi.number().integer().min(1).max(1000).default(5),
  search: Joi.string().trim().max(100).optional(),
  stock: Joi.string().valid("all", "available", "low", "out").default("all")
}).required();
const createBody = Joi.object<FabricCreateInput>({
  colorHex: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null).optional(),
  colorName: Joi.string().trim().max(100).allow(null, "").optional(),
  material: Joi.string().trim().max(100).allow(null, "").optional(),
  name: Joi.string().trim().min(1).max(200).required(),
  quantityOnHand: Joi.number().integer().min(0).max(10_000_000).default(0),
  sku: Joi.string().trim().min(1).max(100).required()
}).required();
const updateBody = Joi.object<FabricUpdateInput>({
  colorHex: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow(null).optional(),
  colorName: Joi.string().trim().max(100).allow(null, "").optional(),
  material: Joi.string().trim().max(100).allow(null, "").optional(),
  name: Joi.string().trim().min(1).max(200).optional(),
  sku: Joi.string().trim().min(1).max(100).optional(),
  status: Joi.string().valid("active", "archived").optional()
}).min(1).required();
const adjustmentBody = Joi.object<FabricAdjustmentInput>({
  deltaOnHand: Joi.number().integer().min(-10_000_000).max(10_000_000).invalid(0).required(),
  reason: Joi.string().trim().min(3).max(500).required()
}).required();
const linkBody = Joi.object<FabricListingLinkInput>({
  active: Joi.boolean().required(),
  isDefault: Joi.boolean().required(),
  sortOrder: Joi.number().integer().min(0).max(100_000).required()
}).required();
const restockBody = Joi.object<FabricRestockInput>({
  orderItemId: uuid.required(),
  quantity: Joi.number().integer().positive().max(100_000).required(),
  reason: Joi.string().trim().min(3).max(500).required(),
  usableUnitsConfirmed: Joi.boolean().valid(true).required()
}).required();

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", message, statusCode: 400 });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof InventoryError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      statusCode: error.statusCode
    });
  }
  throw error;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 1 || key.length > 128) {
    validationError(reply, "A valid Idempotency-Key header is required.");
    return null;
  }
  return key;
}

async function actor(
  repository: AdminInventoryReader,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<InventoryActor | null> {
  const resolved = await repository.resolveActor(request.auth!.userId);
  if (!resolved) {
    reply.code(403).send({
      error: "INVENTORY_ACTOR_UNAVAILABLE",
      message: "A verified active administrator profile is required.",
      statusCode: 403
    });
    return null;
  }
  return resolved;
}

export type AdminInventoryPluginDependencies = {
  repository?: AdminInventoryReader;
};

export function createAdminInventoryPlugin(
  dependencies: AdminInventoryPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const repository = dependencies.repository ?? new AdminInventoryRepository(fastify.pg);

    fastify.get(
      "/",
      adminRoute("inventory:read"),
      async (request, reply) => {
        const parsed = listQuery.validate(request.query, {
          abortEarly: false,
          allowUnknown: false
        });
        if (parsed.error) return validationError(reply, parsed.error.message);
        const report = await repository.list(parsed.value);
        request.log.info(
          {
            event: "admin.inventory.read.completed",
            poolCount: report.pools.length,
            stock: parsed.value.stock
          },
          "Admin inventory read completed",
        );
        return report;
      },
    );

    fastify.post(
      "/fabrics",
      adminRoute("inventory:write"),
      async (request, reply) => {
        const parsed = createBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (parsed.error) return validationError(reply, parsed.error.message);
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;
        try {
          const result = await repository.createFabric(
            resolvedActor,
            parsed.value,
            key,
            inventoryRequestFingerprint("fabric.create", "new", parsed.value),
          );
          request.log.info(
            { event: "admin.inventory.fabric.created", fabricId: result.value.id, replayed: result.replayed },
            "Admin fabric inventory mutation completed",
          );
          return reply.code(result.replayed ? 200 : 201).send(result.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.patch(
      "/fabrics/:fabricId",
      adminRoute("inventory:write"),
      async (request, reply) => {
        const params = fabricParams.validate(request.params, { allowUnknown: false });
        const body = updateBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) return validationError(reply, params.error?.message ?? body.error!.message);
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;
        try {
          const target = params.value.fabricId;
          const result = await repository.updateFabric(
            target,
            resolvedActor,
            body.value,
            key,
            inventoryRequestFingerprint("fabric.update", target, body.value),
          );
          request.log.info(
            { event: "admin.inventory.fabric.updated", fabricId: target, replayed: result.replayed },
            "Admin fabric inventory mutation completed",
          );
          return reply.code(200).send(result.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post(
      "/fabrics/:fabricId/adjustments",
      adminRoute("inventory:write"),
      async (request, reply) => {
        const params = fabricParams.validate(request.params, { allowUnknown: false });
        const body = adjustmentBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) return validationError(reply, params.error?.message ?? body.error!.message);
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;
        try {
          const target = params.value.fabricId;
          const result = await repository.adjustStock(
            target,
            resolvedActor,
            body.value,
            key,
            inventoryRequestFingerprint("fabric.adjust", target, body.value),
          );
          request.log.info(
            {
              deltaOnHand: body.value.deltaOnHand,
              event: "admin.inventory.stock.adjusted",
              fabricId: target,
              replayed: result.replayed
            },
            "Admin fabric inventory mutation completed",
          );
          return reply.code(200).send(result.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.put(
      "/fabrics/:fabricId/listings/:listingId",
      adminRoute("inventory:write"),
      async (request, reply) => {
        const params = listingParams.validate(request.params, { allowUnknown: false });
        const body = linkBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) return validationError(reply, params.error?.message ?? body.error!.message);
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;
        try {
          const target = `${params.value.fabricId}:${params.value.listingId}`;
          const result = await repository.linkListing(
            params.value.fabricId,
            params.value.listingId,
            resolvedActor,
            body.value,
            key,
            inventoryRequestFingerprint("fabric.link", target, body.value),
          );
          request.log.info(
            {
              event: "admin.inventory.listing_link.updated",
              fabricId: params.value.fabricId,
              listingId: params.value.listingId,
              replayed: result.replayed
            },
            "Admin fabric inventory mutation completed",
          );
          return reply.code(200).send(result.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post(
      "/fabrics/:fabricId/restocks",
      adminRoute("inventory:write"),
      async (request, reply) => {
        const params = fabricParams.validate(request.params, { allowUnknown: false });
        const body = restockBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) return validationError(reply, params.error?.message ?? body.error!.message);
        const key = idempotencyKey(request, reply);
        if (!key) return;
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;
        try {
          const target = params.value.fabricId;
          const result = await repository.restockReturnedUnits(
            target,
            resolvedActor,
            body.value,
            key,
            inventoryRequestFingerprint("fabric.restock", target, body.value),
          );
          request.log.info(
            {
              event: "admin.inventory.return.restocked",
              fabricId: target,
              orderItemId: body.value.orderItemId,
              quantity: body.value.quantity,
              replayed: result.replayed
            },
            "Admin fabric inventory mutation completed",
          );
          return reply.code(200).send(result.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  };

  return fp(plugin, { encapsulate: true, name: "admin-inventory-plugin" });
}

export default createAdminInventoryPlugin();
