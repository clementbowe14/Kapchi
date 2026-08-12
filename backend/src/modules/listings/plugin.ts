import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import { ListingNotFoundError, ListingsUnavailableError } from "./errors.js";
import { ListingsRepository } from "./repository.js";
import { ListingsService } from "./service.js";

const querySchema = Joi.object({
  type: Joi.string().valid("graduation_stole").required()
}).required();

const paramsSchema = Joi.object({
  slug: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(160)
    .required()
}).required();

function requestError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
) {
  return reply.code(statusCode).send({ error, message, statusCode });
}

function handleReadError(reply: FastifyReply, error: unknown) {
  if (error instanceof ListingNotFoundError) {
    return requestError(reply, 404, "LISTING_NOT_FOUND", error.message);
  }
  if (error instanceof ListingsUnavailableError) {
    reply.header("Retry-After", "1");
    return requestError(reply, 503, "LISTINGS_UNAVAILABLE", error.message);
  }
  throw error;
}

const listingsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get("/", async (request, reply) => {
    const parsed = querySchema.validate(request.query, {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: false
    });
    if (parsed.error) {
      return requestError(reply, 400, "VALIDATION_ERROR", parsed.error.message);
    }

    const service = new ListingsService(
      new ListingsRepository(fastify.pg),
      request.log,
    );
    try {
      const items = await service.list(request.id);
      return { items, requestId: request.id };
    } catch (error) {
      return handleReadError(reply, error);
    }
  });

  fastify.get("/:slug", async (request, reply) => {
    const parsed = paramsSchema.validate(request.params, {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: false
    });
    if (parsed.error) {
      return requestError(reply, 400, "VALIDATION_ERROR", parsed.error.message);
    }

    const slug = (parsed.value as { slug: string }).slug;
    const service = new ListingsService(
      new ListingsRepository(fastify.pg),
      request.log,
    );
    try {
      return await service.detail(request.id, slug);
    } catch (error) {
      return handleReadError(reply, error);
    }
  });
};

export default fp(listingsPlugin, {
  encapsulate: true,
  name: "listings-module"
});
