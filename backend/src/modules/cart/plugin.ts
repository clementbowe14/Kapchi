import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, RouteHandlerMethod } from "fastify";
import Joi from "joi";
import { authMiddleware, requireAuth } from "../auth/index.js";
import {
  GUEST_SESSION_COOKIE,
  getGuestCartClaimContext,
  getGuestCartContext,
  getOrCreateGuestCartContext
} from "./guest-session.js";
import { CartClaimConflictError, CartClaimForbiddenError } from "./claim-errors.js";
import { CartClaimService } from "./claim-service.js";
import {
  CartConflictError,
  CartItemNotFoundError,
  CartNotFoundError,
  CartValidationError
} from "./errors.js";
import { CartService } from "./service.js";
import type { CartItemInput } from "./types.js";

const cartItemSchema = Joi.object<CartItemInput>({
  fabricId: Joi.string().guid().allow(null).default(null),
  imageAssetId: Joi.string().guid().allow(null).default(null),
  line1: Joi.string().allow("").max(512).default(""),
  line2: Joi.string().allow("").max(512).default(""),
  listingCustomizationSetId: Joi.string().guid().required(),
  listingId: Joi.string().guid().required(),
  listingPriceVariantId: Joi.string().guid().required(),
  quantity: Joi.number().integer().min(1).max(999).required()
}).required();

const cartItemParamsSchema = Joi.object({
  cartItemId: Joi.string().guid().required()
}).required();

function requestError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
) {
  return reply.code(statusCode).send({ error, message, statusCode });
}

function handleCartError(reply: FastifyReply, error: unknown) {
  if (error instanceof CartValidationError) {
    return requestError(reply, 400, "VALIDATION_ERROR", error.message);
  }
  if (error instanceof CartConflictError || error instanceof RangeError) {
    return requestError(reply, 409, "CART_CONFLICT", error.message);
  }
  if (error instanceof CartItemNotFoundError) {
    return requestError(reply, 404, "CART_ITEM_NOT_FOUND", error.message);
  }
  if (error instanceof CartNotFoundError) {
    return requestError(reply, 404, "CART_NOT_FOUND", error.message);
  }

  throw error;
}

function parseCartItem(body: unknown) {
  return cartItemSchema.validate(body, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: false
  });
}

function rejectAuthenticatedMutation(reply: FastifyReply) {
  return requestError(
    reply,
    403,
    "AUTHENTICATED_CART_MUTATION_UNAVAILABLE",
    "Authenticated cart mutations are not available yet.",
  );
}

const cartPlugin: FastifyPluginAsync = async (fastify) => {
  const service = new CartService(fastify.pg, fastify.redis, fastify.log);
  const claimService = new CartClaimService(
    fastify.pg,
    fastify.redis,
    fastify.log,
  );

  const getCart: RouteHandlerMethod = async (request, reply) => {
    if (request.auth) {
      return service.getAuthenticatedCart(request.auth.userId);
    }

    const guestCart = await getOrCreateGuestCartContext(request, reply);
    const cart = await service.getGuestCart(guestCart);

    return {
      cartId: cart.cartId,
      items: cart.items,
      subtotalCents: cart.subtotalCents
    };
  };

  fastify.get("/", { preHandler: [authMiddleware] }, getCart);

  fastify.post(
    "/claim",
    { preHandler: [authMiddleware, requireAuth] },
    async (request, reply) => {
      if (!request.auth) {
        return;
      }

      const guestContext = await getGuestCartClaimContext(request);

      try {
        const result = await claimService.claim(request.auth, guestContext);

        if (request.cookies[GUEST_SESSION_COOKIE]) {
          reply.clearCookie(GUEST_SESSION_COOKIE, { path: "/" });
        }

        return result;
      } catch (error) {
        if (error instanceof CartClaimForbiddenError) {
          return requestError(reply, 403, "FORBIDDEN", error.message);
        }
        if (error instanceof CartClaimConflictError) {
          return requestError(reply, 409, "CART_CLAIM_CONFLICT", error.message);
        }

        throw error;
      }
    },
  );

  fastify.post(
    "/items",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (request.auth) {
        return rejectAuthenticatedMutation(reply);
      }

      const { error, value } = parseCartItem(request.body);

      if (error) {
        return requestError(reply, 400, "VALIDATION_ERROR", error.message);
      }

      try {
        const context = await getOrCreateGuestCartContext(request, reply);
        const result = await service.addGuestItem(context, value as CartItemInput);
        return reply.code(201).send(result);
      } catch (mutationError) {
        return handleCartError(reply, mutationError);
      }
    },
  );

  fastify.patch(
    "/items/:cartItemId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (request.auth) {
        return rejectAuthenticatedMutation(reply);
      }

      const body = parseCartItem(request.body);
      const params = cartItemParamsSchema.validate(request.params, {
        abortEarly: false,
        allowUnknown: false
      });

      if (body.error || params.error) {
        return requestError(
          reply,
          400,
          "VALIDATION_ERROR",
          body.error?.message ??
            params.error?.message ??
            "Invalid cart item request.",
        );
      }

      const context = await getGuestCartContext(request);
      if (!context) {
        return requestError(reply, 404, "CART_NOT_FOUND", "Cart not found.");
      }

      try {
        return await service.updateGuestItem(
          context,
          (params.value as { cartItemId: string }).cartItemId,
          body.value as CartItemInput,
        );
      } catch (mutationError) {
        return handleCartError(reply, mutationError);
      }
    },
  );

  fastify.delete(
    "/items/:cartItemId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      if (request.auth) {
        return rejectAuthenticatedMutation(reply);
      }

      const { error, value } = cartItemParamsSchema.validate(request.params, {
        abortEarly: false,
        allowUnknown: false
      });

      if (error) {
        return requestError(reply, 400, "VALIDATION_ERROR", error.message);
      }

      const context = await getGuestCartContext(request);
      if (!context) {
        return requestError(reply, 404, "CART_NOT_FOUND", "Cart not found.");
      }

      try {
        return await service.removeGuestItem(
          context,
          (value as { cartItemId: string }).cartItemId,
        );
      } catch (mutationError) {
        return handleCartError(reply, mutationError);
      }
    },
  );
};

export default fp(cartPlugin, {
  name: "cart-module"
});
