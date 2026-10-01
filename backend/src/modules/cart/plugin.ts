import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  RouteHandlerMethod
} from "fastify";
import Joi from "joi";
import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import type { AuthContext } from "../../types/auth.js";
import { authMiddleware, requireAuth } from "../auth/index.js";
import {
  GUEST_SESSION_COOKIE,
  getGuestCartClaimContext,
  getGuestCartContext,
  getOrCreateGuestCartContext,
  type GuestCartContext
} from "./guest-session.js";
import { CartClaimConflictError, CartClaimForbiddenError } from "./claim-errors.js";
import { CartClaimService } from "./claim-service.js";
import {
  createCartObserver,
  observableCartFields,
  type CartActorType,
  type CartEventFields,
  type CartObserver,
  type CartOperation,
  type CartSuccessEvent
} from "./cart-observer.js";
import {
  CartConflictError,
  CartIdempotencyConflictError,
  CartItemNotFoundError,
  CartNotFoundError,
  CartValidationError,
  InvalidProductionPriorityError
} from "./errors.js";
import { CartService } from "./service.js";
import type { CartItemInput } from "./types.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const cartItemSchema = Joi.object<CartItemInput>({
  fabricId: Joi.string().guid().allow(null).default(null),
  fontOptionId: Joi.string().guid().allow(null).default(null),
  imageAssetId: Joi.string().guid().allow(null).default(null),
  line1: Joi.string().allow("").max(512).default(""),
  line2: Joi.string().allow("").max(512).default(""),
  listingCustomizationSetId: Joi.string().guid().required(),
  listingId: Joi.string().guid().required(),
  listingPriceVariantId: Joi.string().guid().required(),
  priorityCode: Joi.string().trim().lowercase().pattern(/^[a-z][a-z0-9_]{0,31}$/).required(),
  quantity: Joi.number().integer().min(1).max(999).required(),
  trimOptionId: Joi.string().guid().allow(null).default(null)
}).required();

const cartItemParamsSchema = Joi.object({
  cartItemId: Joi.string().guid().required()
}).required();

type CartViewResult = {
  cartId?: string;
  cartItemId?: string;
  items: unknown[];
  lineItemCount?: number;
  revision?: number;
  subtotalCents: number;
  totalQuantity?: number;
  warnings?: unknown[];
  productionEstimateDiagnostics?: unknown;
};

type CartSummaryResult = {
  cartId?: string;
  lineItemCount: number;
  revision: number;
  subtotalCents?: number;
  totalQuantity: number;
};

type CartServicePort = {
  addGuestItem(
    context: GuestCartContext,
    input: CartItemInput,
    idempotencyKey: string,
  ): Promise<CartViewResult>;
  getAuthenticatedCart(authSubject: string): Promise<CartViewResult>;
  getAuthenticatedCartSummary(authSubject: string): Promise<CartSummaryResult>;
  getGuestCart(context: GuestCartContext): Promise<CartViewResult>;
  getGuestCartSummary(context: GuestCartContext): Promise<CartSummaryResult>;
  removeGuestItem(
    context: GuestCartContext,
    cartItemId: string,
  ): Promise<CartViewResult>;
  updateGuestItem(
    context: GuestCartContext,
    cartItemId: string,
    input: CartItemInput,
  ): Promise<CartViewResult>;
};

type CartClaimServicePort = {
  claim(
    auth: AuthContext,
    guestContext: GuestCartContext | null,
  ): Promise<CartViewResult>;
};

type ServiceFactoryDependencies = {
  logger: FastifyBaseLogger;
  pg: Pick<Pool, "connect" | "query">;
  redis: RedisClientType;
};

export type CartPluginDependencies = {
  cartServiceFactory?: (
    dependencies: ServiceFactoryDependencies,
  ) => CartServicePort;
  claimServiceFactory?: (
    dependencies: ServiceFactoryDependencies,
  ) => CartClaimServicePort;
  observerFactory?: (logger: FastifyBaseLogger) => CartObserver;
};

type ApiError = {
  errorCode: string;
  message: string;
  statusCode: number;
};

const EMPTY_CART_SUMMARY: CartSummaryResult = Object.freeze({
  lineItemCount: 0,
  revision: 0,
  totalQuantity: 0
});

function requestError(reply: FastifyReply, apiError: ApiError) {
  return reply.code(apiError.statusCode).send({
    error: apiError.errorCode,
    message: apiError.message,
    statusCode: apiError.statusCode
  });
}

function cartApiError(error: unknown): ApiError | null {
  if (error instanceof InvalidProductionPriorityError) {
    return {
      errorCode: "INVALID_PRODUCTION_PRIORITY",
      message: error.message,
      statusCode: 400
    };
  }
  if (error instanceof CartValidationError) {
    return { errorCode: "VALIDATION_ERROR", message: error.message, statusCode: 400 };
  }
  if (error instanceof CartIdempotencyConflictError) {
    return {
      errorCode: "CART_IDEMPOTENCY_CONFLICT",
      message: error.message,
      statusCode: 409
    };
  }
  if (error instanceof CartConflictError || error instanceof RangeError) {
    return { errorCode: "CART_CONFLICT", message: error.message, statusCode: 409 };
  }
  if (error instanceof CartItemNotFoundError) {
    return {
      errorCode: "CART_ITEM_NOT_FOUND",
      message: error.message,
      statusCode: 404
    };
  }
  if (error instanceof CartNotFoundError) {
    return { errorCode: "CART_NOT_FOUND", message: error.message, statusCode: 404 };
  }
  return null;
}

function claimApiError(error: unknown): ApiError | null {
  if (error instanceof CartClaimForbiddenError) {
    return { errorCode: "FORBIDDEN", message: error.message, statusCode: 403 };
  }
  if (error instanceof CartClaimConflictError) {
    return {
      errorCode: "CART_CLAIM_CONFLICT",
      message: error.message,
      statusCode: 409
    };
  }
  return null;
}

function parseCartItem(body: unknown) {
  return cartItemSchema.validate(body, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: false
  });
}

function parseIdempotencyKey(header: string | string[] | undefined) {
  if (header === undefined) {
    // Keep older clients working during independent frontend/backend rollouts.
    // The generated key protects this request only; retry-safe clients send one.
    return { value: randomUUID() };
  }
  if (typeof header !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    return {
      error: {
        errorCode: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be 1-128 safe ASCII characters.",
        statusCode: 400
      } satisfies ApiError
    };
  }
  return { value: header };
}

function publicCartView(result: CartViewResult) {
  return {
    ...(result.cartId ? { cartId: result.cartId } : {}),
    items: result.items,
    ...(result.cartItemId ? { cartItemId: result.cartItemId } : {}),
    ...(result.lineItemCount !== undefined
      ? { lineItemCount: result.lineItemCount }
      : {}),
    ...(result.revision !== undefined ? { revision: result.revision } : {}),
    subtotalCents: result.subtotalCents,
    ...(result.totalQuantity !== undefined
      ? { totalQuantity: result.totalQuantity }
      : {}),
    ...(result.warnings ? { warnings: result.warnings } : {})
  };
}

function actorType(authenticated: boolean): CartActorType {
  return authenticated ? "authenticated" : "guest";
}

function completed(
  observer: CartObserver,
  event: CartSuccessEvent,
  operation: CartOperation,
  actor: CartActorType,
  result: unknown,
  startedAt: number,
  identifiers: Partial<CartEventFields> = {},
) {
  observer.completed(
    event,
    {
      actorType: actor,
      operation,
      ...identifiers,
      ...observableCartFields(result)
    } as CartEventFields,
    startedAt,
  );
}

function failed(
  observer: CartObserver,
  operation: CartOperation,
  actor: CartActorType,
  error: unknown,
  apiError: ApiError,
  startedAt: number,
  identifiers: Partial<CartEventFields> = {},
) {
  observer.failed(
    {
      actorType: actor,
      ...identifiers,
      errorCode: apiError.errorCode,
      operation,
      statusCode: apiError.statusCode
    },
    error,
    startedAt,
  );
}

function unexpectedFailure(
  observer: CartObserver,
  operation: CartOperation,
  actor: CartActorType,
  error: unknown,
  startedAt: number,
  identifiers: Partial<CartEventFields> = {},
) {
  observer.failed(
    { actorType: actor, ...identifiers, operation, statusCode: 500 },
    error,
    startedAt,
  );
}

function validationFailure(
  observer: CartObserver,
  operation: CartOperation,
  actor: CartActorType,
  apiError: ApiError,
  startedAt: number,
  identifiers: Partial<CartEventFields> = {},
) {
  const error = new Error(apiError.message);
  error.name = "CartRequestValidationError";
  failed(observer, operation, actor, error, apiError, startedAt, identifiers);
}

export function createCartPlugin(dependencies: CartPluginDependencies = {}) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const observerFactory = dependencies.observerFactory ?? createCartObserver;
    const cartServiceFactory =
      dependencies.cartServiceFactory ??
      ((serviceDependencies: ServiceFactoryDependencies) =>
        new CartService(serviceDependencies.pg) as unknown as CartServicePort);
    const claimServiceFactory =
      dependencies.claimServiceFactory ??
      ((serviceDependencies: ServiceFactoryDependencies) =>
        new CartClaimService(
          serviceDependencies.pg,
          serviceDependencies.redis,
          serviceDependencies.logger,
        ) as unknown as CartClaimServicePort);
    const servicesFor = (logger: FastifyBaseLogger) => {
      const serviceDependencies = {
        logger,
        pg: fastify.pg,
        redis: fastify.redis
      };
      return {
        cart: cartServiceFactory(serviceDependencies),
        claim: claimServiceFactory(serviceDependencies)
      };
    };

    const getCart: RouteHandlerMethod = async (request, reply) => {
      const actor = actorType(Boolean(request.auth));
      const observer = observerFactory(request.log);
      const startedAt = observer.start();
      const service = servicesFor(request.log).cart;

      try {
        const result = request.auth
          ? await service.getAuthenticatedCart(request.auth.userId)
          : await service.getGuestCart(
              await getOrCreateGuestCartContext(request, reply),
            );
        completed(observer, "cart.read.completed", "read", actor, result, startedAt);
        return publicCartView(result);
      } catch (error) {
        const apiError = cartApiError(error);
        if (apiError) {
          failed(observer, "read", actor, error, apiError, startedAt);
          return requestError(reply, apiError);
        }
        unexpectedFailure(observer, "read", actor, error, startedAt);
        throw error;
      }
    };

    fastify.get("/", { preHandler: [authMiddleware] }, getCart);

    fastify.get(
      "/summary",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const actor = actorType(Boolean(request.auth));
        const observer = observerFactory(request.log);
        const startedAt = observer.start();
        const service = servicesFor(request.log).cart;

        try {
          let result: CartSummaryResult;
          if (request.auth) {
            result = await service.getAuthenticatedCartSummary(request.auth.userId);
          } else {
            const context = await getGuestCartContext(request);
            result = context
              ? await service.getGuestCartSummary(context)
              : EMPTY_CART_SUMMARY;
          }
          completed(
            observer,
            "cart.read.completed",
            "summary",
            actor,
            result,
            startedAt,
          );
          return result;
        } catch (error) {
          const apiError = cartApiError(error);
          if (apiError) {
            failed(observer, "summary", actor, error, apiError, startedAt);
            return requestError(reply, apiError);
          }
          unexpectedFailure(observer, "summary", actor, error, startedAt);
          throw error;
        }
      },
    );

    fastify.post(
      "/claim",
      { preHandler: [authMiddleware, requireAuth] },
      async (request, reply) => {
        if (!request.auth) {
          return;
        }
        const observer = observerFactory(request.log);
        const startedAt = observer.start();
        const service = servicesFor(request.log).claim;

        try {
          const guestContext = await getGuestCartClaimContext(request);
          const result = await service.claim(request.auth, guestContext);

          if (request.cookies[GUEST_SESSION_COOKIE]) {
            reply.clearCookie(GUEST_SESSION_COOKIE, { path: "/" });
          }
          completed(
            observer,
            "cart.claim.completed",
            "claim",
            "authenticated",
            result,
            startedAt,
          );
          return publicCartView(result);
        } catch (error) {
          const apiError = claimApiError(error);
          if (apiError) {
            failed(
              observer,
              "claim",
              "authenticated",
              error,
              apiError,
              startedAt,
            );
            return requestError(reply, apiError);
          }
          unexpectedFailure(
            observer,
            "claim",
            "authenticated",
            error,
            startedAt,
          );
          throw error;
        }
      },
    );

    fastify.post(
      "/items",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const actor = actorType(Boolean(request.auth));
        const observer = observerFactory(request.log);
        const startedAt = observer.start();

        if (request.auth) {
          const apiError = {
            errorCode: "AUTHENTICATED_CART_MUTATION_UNAVAILABLE",
            message: "Authenticated cart mutations are not available yet.",
            statusCode: 403
          } satisfies ApiError;
          validationFailure(observer, "add", actor, apiError, startedAt);
          return requestError(reply, apiError);
        }

        const idempotency = parseIdempotencyKey(request.headers["idempotency-key"]);
        if (idempotency.error) {
          validationFailure(observer, "add", actor, idempotency.error, startedAt);
          return requestError(reply, idempotency.error);
        }
        const parsed = parseCartItem(request.body);
        if (parsed.error) {
          const apiError = {
            errorCode: "VALIDATION_ERROR",
            message: parsed.error.message,
            statusCode: 400
          } satisfies ApiError;
          failed(observer, "add", actor, parsed.error, apiError, startedAt);
          return requestError(reply, apiError);
        }

        let cartId: string | undefined;
        try {
          const context = await getOrCreateGuestCartContext(request, reply);
          cartId = context.cartId;
          const result = await servicesFor(request.log).cart.addGuestItem(
            context,
            parsed.value as CartItemInput,
            idempotency.value,
          );
          completed(observer, "cart.item.added", "add", actor, result, startedAt, {
            customizationPackageId: parsed.value.listingCustomizationSetId,
            listingId: parsed.value.listingId,
            priorityCode: parsed.value.priorityCode,
          });
          return reply.code(201).send(publicCartView(result));
        } catch (error) {
          const apiError = cartApiError(error);
          if (apiError) {
            failed(observer, "add", actor, error, apiError, startedAt, {
              cartId,
              customizationPackageId: parsed.value.listingCustomizationSetId,
              listingId: parsed.value.listingId,
              priorityCode: parsed.value.priorityCode,
            });
            return requestError(reply, apiError);
          }
          unexpectedFailure(observer, "add", actor, error, startedAt, { cartId });
          throw error;
        }
      },
    );

    fastify.patch(
      "/items/:cartItemId",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const actor = actorType(Boolean(request.auth));
        const observer = observerFactory(request.log);
        const startedAt = observer.start();

        if (request.auth) {
          const apiError = {
            errorCode: "AUTHENTICATED_CART_MUTATION_UNAVAILABLE",
            message: "Authenticated cart mutations are not available yet.",
            statusCode: 403
          } satisfies ApiError;
          validationFailure(observer, "update", actor, apiError, startedAt);
          return requestError(reply, apiError);
        }

        const body = parseCartItem(request.body);
        const params = cartItemParamsSchema.validate(request.params, {
          abortEarly: false,
          allowUnknown: false
        });
        const cartItemId = (params.value as { cartItemId?: string }).cartItemId;

        if (body.error || params.error || !cartItemId) {
          const validationError = body.error ?? params.error;
          const apiError = {
            errorCode: "VALIDATION_ERROR",
            message: validationError?.message ?? "Invalid cart item request.",
            statusCode: 400
          } satisfies ApiError;
          failed(
            observer,
            "update",
            actor,
            validationError ?? new Error(apiError.message),
            apiError,
            startedAt,
            { cartItemId },
          );
          return requestError(reply, apiError);
        }

        let context: GuestCartContext | null = null;
        try {
          context = await getGuestCartContext(request);
          if (!context) {
            const apiError = {
              errorCode: "CART_NOT_FOUND",
              message: "Cart not found.",
              statusCode: 404
            } satisfies ApiError;
            validationFailure(observer, "update", actor, apiError, startedAt, {
              cartItemId
            });
            return requestError(reply, apiError);
          }

          const result = await servicesFor(request.log).cart.updateGuestItem(
            context,
            cartItemId,
            body.value as CartItemInput,
          );
          completed(observer, "cart.item.updated", "update", actor, result, startedAt, {
            customizationPackageId: body.value.listingCustomizationSetId,
            listingId: body.value.listingId,
            priorityCode: body.value.priorityCode,
          });
          return publicCartView(result);
        } catch (error) {
          const apiError = cartApiError(error);
          const identifiers = { cartId: context?.cartId, cartItemId };
          if (apiError) {
            failed(observer, "update", actor, error, apiError, startedAt, {
              ...identifiers,
              customizationPackageId: body.value.listingCustomizationSetId,
              listingId: body.value.listingId,
              priorityCode: body.value.priorityCode,
            });
            return requestError(reply, apiError);
          }
          unexpectedFailure(observer, "update", actor, error, startedAt, identifiers);
          throw error;
        }
      },
    );

    fastify.delete(
      "/items/:cartItemId",
      { preHandler: [authMiddleware] },
      async (request, reply) => {
        const actor = actorType(Boolean(request.auth));
        const observer = observerFactory(request.log);
        const startedAt = observer.start();

        if (request.auth) {
          const apiError = {
            errorCode: "AUTHENTICATED_CART_MUTATION_UNAVAILABLE",
            message: "Authenticated cart mutations are not available yet.",
            statusCode: 403
          } satisfies ApiError;
          validationFailure(observer, "remove", actor, apiError, startedAt);
          return requestError(reply, apiError);
        }

        const params = cartItemParamsSchema.validate(request.params, {
          abortEarly: false,
          allowUnknown: false
        });
        const cartItemId = (params.value as { cartItemId?: string }).cartItemId;
        if (params.error || !cartItemId) {
          const apiError = {
            errorCode: "VALIDATION_ERROR",
            message: params.error?.message ?? "Invalid cart item request.",
            statusCode: 400
          } satisfies ApiError;
          failed(
            observer,
            "remove",
            actor,
            params.error ?? new Error(apiError.message),
            apiError,
            startedAt,
            { cartItemId },
          );
          return requestError(reply, apiError);
        }

        let context: GuestCartContext | null = null;
        try {
          context = await getGuestCartContext(request);
          if (!context) {
            const apiError = {
              errorCode: "CART_NOT_FOUND",
              message: "Cart not found.",
              statusCode: 404
            } satisfies ApiError;
            validationFailure(observer, "remove", actor, apiError, startedAt, {
              cartItemId
            });
            return requestError(reply, apiError);
          }

          const result = await servicesFor(request.log).cart.removeGuestItem(
            context,
            cartItemId,
          );
          completed(observer, "cart.item.removed", "remove", actor, result, startedAt);
          return publicCartView(result);
        } catch (error) {
          const apiError = cartApiError(error);
          const identifiers = { cartId: context?.cartId, cartItemId };
          if (apiError) {
            failed(observer, "remove", actor, error, apiError, startedAt, identifiers);
            return requestError(reply, apiError);
          }
          unexpectedFailure(observer, "remove", actor, error, startedAt, identifiers);
          throw error;
        }
      },
    );
  };

  return fp(plugin, {
    encapsulate: true,
    name: "cart-module"
  });
}

export default createCartPlugin();
