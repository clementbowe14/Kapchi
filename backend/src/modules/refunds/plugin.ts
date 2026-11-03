import fp from "fastify-plugin";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { adminRoute } from "../admin-auth/index.js";
import { HttpMessageProvider } from "../admin-messaging/provider.js";
import { AdminMessagingRepository } from "../admin-messaging/repository.js";
import { AdminMessagingService } from "../admin-messaging/service.js";
import { TransactionalNotificationOperationsAdapter } from "../admin-messaging/transactional-operations.js";
import { createStripeClient } from "../payments/stripe-client.js";
import { RefundError } from "./errors.js";
import { StripeRefundProvider, type RefundProvider } from "./provider.js";
import { RefundRepository } from "./repository.js";
import { RefundService, type RefundObserver, type RefundRepositoryPort } from "./service.js";
import type { RefundRequest } from "./types.js";

const orderParams = Joi.object({ orderId: Joi.string().guid().required() }).required();
const operationParams = Joi.object({ operationId: Joi.string().guid().required() }).required();
const bodySchema = Joi.object<RefundRequest>({
  amountCents: Joi.number().integer().positive().max(99_999_999).optional(),
  currency: Joi.string().lowercase().pattern(/^[a-z]{3}$/).required(),
  reasonCode: Joi.string()
    .valid("requested_by_customer", "duplicate", "fraudulent", "other")
    .required(),
  reasonNote: Joi.string().trim().max(500).allow(null, "").optional(),
  restockRequested: Joi.boolean().required(),
  notificationRequested: Joi.boolean().required()
}).required();

function observer(logger: FastifyBaseLogger): RefundObserver {
  return {
    error: (event, fields) => logger.error({ event, ...fields }, "Refund lifecycle event"),
    info: (event, fields) => logger.info({ event, ...fields }, "Refund lifecycle event"),
    warn: (event, fields) => logger.warn({ event, ...fields }, "Refund lifecycle event")
  };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof RefundError) {
    if (error.statusCode === 503) reply.header("retry-after", "30");
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      ...(error.operationId ? { operationId: error.operationId } : {}),
      statusCode: error.statusCode
    });
  }
  throw error;
}

export type RefundPluginDependencies = {
  providerFactory?: () => RefundProvider;
  repositoryFactory?: (pool: Pool) => RefundRepositoryPort;
  serviceFactory?: (
    repository: RefundRepositoryPort,
    provider: RefundProvider,
    observer: RefundObserver,
  ) => RefundService;
};

export function createRefundPlugin(dependencies: RefundPluginDependencies = {}) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const provider = dependencies.providerFactory?.() ?? new StripeRefundProvider(createStripeClient());
    const repository = dependencies.repositoryFactory?.(fastify.pg) ?? new RefundRepository(fastify.pg);
    const serviceFor = (logger: FastifyBaseLogger) => {
      const lifecycleObserver = observer(logger);
      const injected = dependencies.serviceFactory?.(
        repository,
        provider,
        lifecycleObserver,
      );
      if (injected) return injected;
      const messagingConfig = config.messaging ?? {
        delivery: {},
        senders: {},
        webhookSecret: undefined
      };
      return new RefundService(
        repository,
        provider,
        lifecycleObserver,
        new AdminMessagingService(
          new AdminMessagingRepository(fastify.pg),
          new HttpMessageProvider(messagingConfig.delivery),
          messagingConfig.senders,
          lifecycleObserver,
          new TransactionalNotificationOperationsAdapter(
            fastify.pg,
            process.env.ORDER_LOOKUP_BASE_URL ?? "http://localhost:3000",
            config.app.nodeEnv,
          ),
        ),
      );
    };
    const protectedRoute = adminRoute("refunds:write");

    fastify.get<{ Params: { orderId: string } }>(
      "/orders/:orderId/refunds/summary",
      protectedRoute,
      async (request, reply) => {
        const parsed = orderParams.validate(request.params, { allowUnknown: false });
        if (parsed.error) return reply.code(400).send({ error: "VALIDATION_ERROR", message: parsed.error.message, statusCode: 400 });
        try {
          return await serviceFor(request.log).getSummary(parsed.value.orderId);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post<{ Params: { orderId: string } }>(
      "/orders/:orderId/refunds",
      protectedRoute,
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        const body = bodySchema.validate(request.body, { allowUnknown: false, abortEarly: false });
        const idempotencyKey = request.headers["idempotency-key"];
        if (params.error || body.error || typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
          return reply.code(400).send({
            error: "VALIDATION_ERROR",
            message: params.error?.message ?? body.error?.message ?? "A valid Idempotency-Key header is required.",
            statusCode: 400
          });
        }
        try {
          const service = serviceFor(request.log);
          const actor = await service.resolveActor(request.auth!.userId);
          if (!actor) {
            return reply.code(403).send({ error: "REFUND_ACTOR_UNAVAILABLE", message: "A verified active administrator profile is required.", statusCode: 403 });
          }
          const result = await service.create(params.value.orderId, actor, body.value, idempotencyKey);
          const code = result.replayed
            ? 200
            : result.operation.status === "succeeded"
              ? 201
              : 202;
          if (code === 202 && result.operation.nextReconciliationAt) reply.header("retry-after", "30");
          return reply.code(code).send(result.operation);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.get<{ Params: { operationId: string } }>(
      "/refunds/:operationId",
      protectedRoute,
      async (request, reply) => {
        const parsed = operationParams.validate(request.params, { allowUnknown: false });
        if (parsed.error) return reply.code(400).send({ error: "VALIDATION_ERROR", message: parsed.error.message, statusCode: 400 });
        try {
          return await serviceFor(request.log).getOperation(parsed.value.operationId);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  };
  return fp(plugin, { encapsulate: true, name: "refunds-module" });
}

export default createRefundPlugin();
