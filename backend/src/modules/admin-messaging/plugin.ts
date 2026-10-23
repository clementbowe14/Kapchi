import fp from "fastify-plugin";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import Joi from "joi";
import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { adminRoute } from "../admin-auth/index.js";
import { MessagingError } from "./errors.js";
import { HttpMessageProvider, type MessageProvider } from "./provider.js";
import { AdminMessagingRepository } from "./repository.js";
import {
  AdminMessagingService,
  type MessagingObserver,
  type MessagingRepositoryPort
} from "./service.js";
import type {
  ConversationQuery,
  MessagingWebhookInput,
  QueueNoteInput,
  QueueReplyInput
} from "./types.js";
import {
  messagingPayloadHash,
  verifyMessagingWebhook
} from "./webhook-signature.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const orderParams = Joi.object({ orderId: uuid.required() }).required();
const providerParams = Joi.object({
  provider: Joi.string().trim().pattern(/^[a-z0-9_-]{1,50}$/).required()
}).required();
const listQuery = Joi.object<ConversationQuery>({
  adminUnread: Joi.boolean().optional(),
  cursor: Joi.string().trim().max(500).optional(),
  limit: Joi.number().integer().min(1).max(100).default(25),
  status: Joi.string().valid("awaiting_admin", "awaiting_customer", "resolved").optional()
}).required();
const replyBody = Joi.object<QueueReplyInput>({
  body: Joi.string().trim().min(1).max(10_000).required(),
  channel: Joi.string().valid("email", "sms").required(),
  subject: Joi.string().trim().max(200).allow(null, "").optional()
}).required();
const noteBody = Joi.object<QueueNoteInput>({
  body: Joi.string().trim().min(1).max(10_000).required()
}).required();
const stateBody = Joi.object({
  action: Joi.string().valid("read", "reopen", "resolve").required(),
  expectedVersion: Joi.number().integer().min(0).required()
}).required();
const webhookBody = Joi.object<MessagingWebhookInput>({
  body: Joi.string().max(50_000).optional(),
  channel: Joi.string().valid("email", "sms").required(),
  errorCode: Joi.string().trim().max(100).optional(),
  eventId: Joi.string().trim().min(1).max(200).required(),
  from: Joi.string().trim().max(500).optional(),
  providerMessageId: Joi.string().trim().max(500).optional(),
  subject: Joi.string().max(500).optional(),
  threadKey: Joi.string().trim().min(1).max(200).required(),
  timestamp: Joi.number().integer().positive().required(),
  to: Joi.string().trim().max(500).optional(),
  type: Joi.string().valid("message.received", "message.sent", "message.failed").required()
}).required();

function observer(logger: FastifyBaseLogger): MessagingObserver {
  return {
    error: (event, fields) => logger.error({ event, ...fields }, "Messaging lifecycle event"),
    info: (event, fields) => logger.info({ event, ...fields }, "Messaging lifecycle event"),
    warn: (event, fields) => logger.warn({ event, ...fields }, "Messaging lifecycle event")
  };
}

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "VALIDATION_ERROR", message, statusCode: 400 });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof MessagingError) {
    if (error.statusCode === 503) reply.header("retry-after", "60");
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      statusCode: error.statusCode
    });
  }
  throw error;
}

function idempotencyKey(request: FastifyRequest, reply: FastifyReply) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    validationError(reply, "A valid Idempotency-Key header is required.");
    return null;
  }
  return value;
}

export type AdminMessagingPluginDependencies = {
  messagingConfig?: typeof config.messaging;
  providerFactory?: () => MessageProvider;
  repositoryFactory?: (pool: Pool) => MessagingRepositoryPort;
  serviceFactory?: (
    repository: MessagingRepositoryPort,
    provider: MessageProvider,
    observer: MessagingObserver,
  ) => AdminMessagingService;
};

export function createAdminMessagingPlugin(
  dependencies: AdminMessagingPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const messagingConfig = dependencies.messagingConfig ?? config.messaging;
    const repository = dependencies.repositoryFactory?.(fastify.pg)
      ?? new AdminMessagingRepository(fastify.pg);
    const provider = dependencies.providerFactory?.()
      ?? new HttpMessageProvider(messagingConfig.delivery);
    const serviceFor = (logger: FastifyBaseLogger) =>
      dependencies.serviceFactory?.(repository, provider, observer(logger))
      ?? new AdminMessagingService(
        repository,
        provider,
        messagingConfig.senders,
        observer(logger),
      );

    fastify.get(
      "/admin/messages/conversations",
      adminRoute("orders:read"),
      async (request, reply) => {
        const parsed = listQuery.validate(request.query, {
          abortEarly: false,
          allowUnknown: false
        });
        if (parsed.error) return validationError(reply, parsed.error.message);
        try {
          return await serviceFor(request.log).list(parsed.value);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.get<{ Params: { orderId: string } }>(
      "/admin/messages/conversations/:orderId",
      adminRoute("orders:read"),
      async (request, reply) => {
        const parsed = orderParams.validate(request.params, { allowUnknown: false });
        if (parsed.error) return validationError(reply, parsed.error.message);
        try {
          return await serviceFor(request.log).detail(parsed.value.orderId);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post<{ Params: { orderId: string } }>(
      "/admin/messages/orders/:orderId/replies",
      adminRoute("messages:write"),
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        const body = replyBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        const key = idempotencyKey(request, reply);
        if (!key) return;
        if (params.error || body.error) {
          return validationError(reply, params.error?.message ?? body.error!.message);
        }
        try {
          const service = serviceFor(request.log);
          const actor = await service.resolveActor(request.auth!.userId);
          if (!actor) {
            return reply.code(403).send({
              error: "MESSAGE_ACTOR_UNAVAILABLE",
              message: "A verified active administrator profile is required.",
              statusCode: 403
            });
          }
          const result = await service.queueReply(
            params.value.orderId,
            actor,
            body.value,
            key,
          );
          request.log.info(
            {
              channel: body.value.channel,
              event: "admin.message.queued",
              messageId: result.message.id,
              orderId: params.value.orderId,
              replayed: result.replayed
            },
            "Admin customer message queued",
          );
          return reply.code(result.replayed ? 200 : 202).send(result.message);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post<{ Params: { orderId: string } }>(
      "/admin/messages/orders/:orderId/notes",
      adminRoute("order-notes:write"),
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        const body = noteBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        const key = idempotencyKey(request, reply);
        if (!key) return;
        if (params.error || body.error) {
          return validationError(reply, params.error?.message ?? body.error!.message);
        }
        try {
          const service = serviceFor(request.log);
          const actor = await service.resolveActor(request.auth!.userId);
          if (!actor) {
            return reply.code(403).send({
              error: "MESSAGE_ACTOR_UNAVAILABLE",
              message: "A verified active administrator profile is required.",
              statusCode: 403
            });
          }
          const result = await service.addNote(
            params.value.orderId,
            actor,
            body.value,
            key,
          );
          return reply.code(result.replayed ? 200 : 201).send(result.message);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.patch<{ Params: { orderId: string } }>(
      "/admin/messages/conversations/:orderId",
      adminRoute("messages:write"),
      async (request, reply) => {
        const params = orderParams.validate(request.params, { allowUnknown: false });
        const body = stateBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) {
          return validationError(reply, params.error?.message ?? body.error!.message);
        }
        try {
          const service = serviceFor(request.log);
          const actor = await service.resolveActor(request.auth!.userId);
          if (!actor) {
            return reply.code(403).send({
              error: "MESSAGE_ACTOR_UNAVAILABLE",
              message: "A verified active administrator profile is required.",
              statusCode: 403
            });
          }
          return await service.updateConversation(
            params.value.orderId,
            actor,
            body.value.action,
            body.value.expectedVersion,
          );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );

    fastify.post<{ Params: { provider: string } }>(
      "/messaging/webhooks/:provider",
      async (request, reply) => {
        const params = providerParams.validate(request.params, { allowUnknown: false });
        const body = webhookBody.validate(request.body, { abortEarly: false, allowUnknown: false });
        if (params.error || body.error) {
          return validationError(reply, params.error?.message ?? body.error!.message);
        }
        const signature = request.headers["x-kapchi-message-signature"];
        if (
          typeof signature !== "string" ||
          !verifyMessagingWebhook(
            body.value,
            signature,
            messagingConfig.webhookSecret,
          )
        ) {
          return reply.code(401).send({
            error: "MESSAGE_WEBHOOK_SIGNATURE_INVALID",
            message: "Message webhook signature is invalid.",
            statusCode: 401
          });
        }
        try {
          const result = await serviceFor(request.log).receiveWebhook(
            params.value.provider,
            body.value,
            messagingPayloadHash(body.value),
          );
          if ("errorCode" in result && result.status === "rejected") {
            const statusCode = result.errorCode === "CONTACT_MISMATCH"
              ? 403
              : result.errorCode === "MESSAGE_ID_REQUIRED"
                ? 400
                : 404;
            return reply.code(statusCode).send({
              error: `MESSAGE_WEBHOOK_${result.errorCode}`,
              message: "Message webhook could not be safely matched.",
              statusCode
            });
          }
          request.log.info(
            {
              channel: body.value.channel,
              duplicate: result.duplicate,
              event: "message.webhook.processed",
              provider: params.value.provider,
              resultCode: result.status,
              webhookType: body.value.type
            },
            "Message webhook processed",
          );
          return reply.code(result.duplicate ? 200 : 202).send(result);
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  };
  return fp(plugin, { encapsulate: true, name: "admin-messaging-module" });
}

export default createAdminMessagingPlugin();
