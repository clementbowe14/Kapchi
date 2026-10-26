import { Readable } from "node:stream";
import fp from "fastify-plugin";
import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest
} from "fastify";
import Joi from "joi";
import { config } from "../../config/index.js";
import { safeErrorDetails } from "../../observability/safe-error.js";
import { adminRoute } from "../admin-auth/index.js";
import { contentDispositionHeader } from "./content.js";
import { AdminAssetError } from "./errors.js";
import { VercelPrivateAssetReader } from "./provider.js";
import {
  AdminAssetRepository,
  type AdminAssetRepositoryPort
} from "./repository.js";
import { AdminAssetService } from "./service.js";
import type {
  AssetDisposition,
  PrivateAssetActor,
  PrivateAssetReader,
  PreparedPrivateAsset
} from "./types.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5"] });
const paramsSchema = Joi.object({
  orderId: uuid.required(),
  orderItemId: uuid.required()
}).required();
const querySchema = Joi.object({
  disposition: Joi.string().valid("attachment", "inline").default("inline")
}).required();

type RouteParams = { orderId: string; orderItemId: string };

type PluginConfig = {
  crossOriginPolicy: "cross-origin" | "same-origin" | "same-site";
  idleTimeoutMs: number;
  maxBytes: number;
  openTimeoutMs: number;
  totalTimeoutMs: number;
};

export type AdminAssetPluginDependencies = {
  config?: Partial<PluginConfig>;
  readers?: Readonly<Record<string, PrivateAssetReader>>;
  repository?: AdminAssetRepositoryPort;
  service?: AdminAssetService;
};

function databaseUnavailable(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String(error.code);
  return code === "ECONNREFUSED" || code === "ETIMEDOUT" || code.startsWith("08") ||
    code === "53300" || code === "57P01" || code === "57P02" || code === "57P03";
}

function responseError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AdminAssetError,
) {
  if (error.retryAfterSeconds !== null) {
    reply.header("retry-after", String(error.retryAfterSeconds));
  }
  return reply.code(error.statusCode).send({
    error: error.code,
    message: error.message,
    requestId: request.id,
    statusCode: error.statusCode
  });
}

function serviceUnavailable(request: FastifyRequest, reply: FastifyReply) {
  reply.header("retry-after", "30");
  return responseError(
    request,
    reply,
    new AdminAssetError(
      "PRIVATE_ASSET_SERVICE_UNAVAILABLE",
      "Private asset access is temporarily unavailable.",
      503,
    ),
  );
}

function validationError(request: FastifyRequest, reply: FastifyReply, message: string) {
  return responseError(
    request,
    reply,
    new AdminAssetError("VALIDATION_ERROR", message, 400),
  );
}

async function actor(
  repository: AdminAssetRepositoryPort,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const resolved = await repository.findActor(request.auth!.userId);
    if (resolved) return resolved;
    responseError(
      request,
      reply,
      new AdminAssetError(
        "ADMIN_ACTOR_UNAVAILABLE",
        "A verified active administrator profile is required.",
        403,
      ),
    );
    return null;
  } catch (error) {
    if (databaseUnavailable(error)) {
      serviceUnavailable(request, reply);
      return null;
    }
    throw error;
  }
}

async function recordFailure(
  repository: AdminAssetRepositoryPort,
  input: {
    actor: PrivateAssetActor;
    disposition: AssetDisposition;
    error: AdminAssetError;
    orderId: string;
    orderItemId: string;
    requestId: string;
  },
) {
  return repository.recordAccess({
    actor: input.actor,
    assetId: input.error.assetId,
    deliveryStatus: "not_started",
    disposition: input.disposition,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    outcome: input.error.statusCode >= 500 ? "failed" : "denied",
    reasonCode: input.error.code,
    requestId: input.requestId
  });
}

function terminalObserver(input: {
  abortController: AbortController;
  auditEventId: string;
  logger: FastifyBaseLogger;
  prepared: PreparedPrivateAsset;
  repository: AdminAssetRepositoryPort;
  requestId: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}) {
  let terminal = false;

  return (status: "aborted" | "completed" | "failed", error?: unknown) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(input.timer);
    if (status !== "completed" && !input.abortController.signal.aborted) {
      input.abortController.abort(status);
    }
    const fields = {
      assetId: input.prepared.assetId,
      byteCount: input.prepared.bytesRead(),
      durationMs: Math.max(0, Math.round((performance.now() - input.startedAt) * 1000) / 1000),
      event: `admin.asset.content.${status}`,
      providerCategory: input.prepared.provider,
      requestId: input.requestId,
      retryCount: input.prepared.retryCount,
      ...(error ? safeErrorDetails(error) : {})
    };
    const message = `Private customization asset stream ${status}`;
    if (status === "failed") input.logger.error(fields, message);
    else if (status === "aborted") input.logger.warn(fields, message);
    else input.logger.info(fields, message);

    void input.repository
      .updateDelivery(
        input.auditEventId,
        status,
        Math.min(input.prepared.bytesRead(), input.prepared.byteSize),
      )
      .catch((auditError) => {
        input.logger.error(
          {
            auditError: safeErrorDetails(auditError),
            event: "admin.asset.audit.terminal_update_failed",
            requestId: input.requestId
          },
          "Private asset terminal audit update failed",
        );
      });
  };
}

export function createAdminAssetPlugin(
  dependencies: AdminAssetPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const repository = dependencies.repository ?? new AdminAssetRepository(fastify.pg);
    const pluginConfig: PluginConfig = {
      crossOriginPolicy: dependencies.config?.crossOriginPolicy ??
        config.assets.privateReads.crossOriginPolicy,
      idleTimeoutMs: dependencies.config?.idleTimeoutMs ??
        config.assets.privateReads.idleTimeoutMs,
      maxBytes: dependencies.config?.maxBytes ?? config.assets.maxImageBytes,
      openTimeoutMs: dependencies.config?.openTimeoutMs ??
        config.assets.privateReads.openTimeoutMs,
      totalTimeoutMs: dependencies.config?.totalTimeoutMs ??
        config.assets.privateReads.totalTimeoutMs
    };
    const readers = dependencies.readers ?? {
      vercel_blob: new VercelPrivateAssetReader(config.assets.privateReads.vercel)
    };
    const service = dependencies.service ?? new AdminAssetService(repository, {
      idleTimeoutMs: pluginConfig.idleTimeoutMs,
      maxBytes: pluginConfig.maxBytes,
      openTimeoutMs: pluginConfig.openTimeoutMs,
      readers
    });

    fastify.get<{ Params: RouteParams }>(
      "/:orderId/items/:orderItemId/customization-asset",
      adminRoute("assets:read"),
      async (request, reply) => {
        const parsed = paramsSchema.validate(request.params, { allowUnknown: false });
        if (parsed.error) return validationError(request, reply, parsed.error.message);
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;

        try {
          const result = await service.metadata(
            parsed.value.orderId,
            parsed.value.orderItemId,
          );
          request.log.info(
            {
              actorUserId: resolvedActor.userId,
              assetId: result.asset?.id ?? null,
              eligibility: result.retrieval.eligibility,
              event: "admin.asset.metadata.resolved",
              orderId: result.orderId,
              orderItemId: result.orderItemId
            },
            "Private customization asset metadata resolved",
          );
          return result;
        } catch (error) {
          if (error instanceof AdminAssetError) {
            return responseError(request, reply, error);
          }
          if (databaseUnavailable(error)) return serviceUnavailable(request, reply);
          throw error;
        }
      },
    );

    fastify.get<{ Params: RouteParams; Querystring: { disposition?: string } }>(
      "/:orderId/items/:orderItemId/customization-asset/content",
      adminRoute("assets:read"),
      async (request, reply) => {
        const parsedParams = paramsSchema.validate(request.params, { allowUnknown: false });
        const parsedQuery = querySchema.validate(request.query, { allowUnknown: false });
        if (parsedParams.error || parsedQuery.error) {
          return validationError(
            request,
            reply,
            parsedParams.error?.message ?? parsedQuery.error!.message,
          );
        }
        if (request.headers.range !== undefined) {
          return responseError(
            request,
            reply,
            new AdminAssetError(
              "RANGE_NOT_SUPPORTED",
              "Partial private asset delivery is not supported.",
              416,
            ),
          );
        }
        const resolvedActor = await actor(repository, request, reply);
        if (!resolvedActor) return;

        const { orderId, orderItemId } = parsedParams.value as RouteParams;
        const disposition = parsedQuery.value.disposition as AssetDisposition;
        const abortController = new AbortController();
        const startedAt = performance.now();
        const timer = setTimeout(
          () => abortController.abort("private asset total timeout"),
          pluginConfig.totalTimeoutMs,
        );
        request.log.info(
          {
            actorUserId: resolvedActor.userId,
            disposition,
            event: "admin.asset.content.requested",
            orderId,
            orderItemId
          },
          "Private customization asset content requested",
        );

        let prepared: PreparedPrivateAsset;
        try {
          prepared = await service.prepare(
            orderId,
            orderItemId,
            abortController.signal,
          );
        } catch (caught) {
          clearTimeout(timer);
          const error = caught instanceof AdminAssetError
            ? caught
            : new AdminAssetError(
                "PRIVATE_ASSET_SERVICE_UNAVAILABLE",
                "Private asset access is temporarily unavailable.",
                503,
              );
          try {
            await recordFailure(repository, {
              actor: resolvedActor,
              disposition,
              error,
              orderId,
              orderItemId,
              requestId: request.id
            });
          } catch (auditError) {
            request.log.error(
              {
                auditError: safeErrorDetails(auditError),
                event: "admin.asset.audit.failed",
                requestId: request.id
              },
              "Private asset failure audit could not be persisted",
            );
            return serviceUnavailable(request, reply);
          }
          request.log.warn(
            {
              actorUserId: resolvedActor.userId,
              assetId: error.assetId,
              disposition,
              errorCode: error.code,
              event: "admin.asset.content.failed",
              durationMs: Math.max(
                0,
                Math.round((performance.now() - startedAt) * 1000) / 1000,
              ),
              orderId,
              orderItemId,
              retryable: error.retryable
            },
            "Private customization asset retrieval failed",
          );
          return responseError(request, reply, error);
        }

        let auditEventId: string;
        try {
          auditEventId = await repository.recordAccess({
            actor: resolvedActor,
            assetId: prepared.assetId,
            deliveryStatus: "streaming",
            disposition,
            orderId,
            orderItemId,
            outcome: "opened",
            reasonCode: null,
            requestId: request.id
          });
        } catch (auditError) {
          clearTimeout(timer);
          abortController.abort("private asset opening audit failed");
          await prepared.stream.cancel("private asset opening audit failed").catch(() => undefined);
          request.log.error(
            {
              auditError: safeErrorDetails(auditError),
              event: "admin.asset.audit.failed",
              requestId: request.id
            },
            "Private asset opening audit could not be persisted",
          );
          return serviceUnavailable(request, reply);
        }

        request.log.info(
          {
            actorUserId: resolvedActor.userId,
            assetId: prepared.assetId,
            event: "admin.asset.provider.opened",
            orderId,
            orderItemId,
            providerCategory: prepared.provider,
            retryCount: prepared.retryCount
          },
          "Private customization asset provider stream opened",
        );

        reply.headers({
          "cache-control": "private, no-store",
          "content-disposition": contentDispositionHeader(disposition, prepared.filename),
          "content-length": String(prepared.byteSize),
          "content-type": prepared.contentType,
          "cross-origin-resource-policy": pluginConfig.crossOriginPolicy,
          "expires": "0",
          "pragma": "no-cache",
          "x-content-type-options": "nosniff"
        });
        if (disposition === "inline") {
          reply.header(
            "content-security-policy",
            "default-src 'none'; sandbox; frame-ancestors 'none'",
          );
        }

        const stream = Readable.from(
          prepared.stream as unknown as AsyncIterable<Uint8Array>,
        );
        const observeTerminal = terminalObserver({
          abortController,
          auditEventId,
          logger: request.log,
          prepared,
          repository,
          requestId: request.id,
          startedAt,
          timer
        });
        stream.once("end", () => observeTerminal("completed"));
        stream.once("error", (error) => observeTerminal("failed", error));
        reply.raw.once("close", () => {
          if (!reply.raw.writableFinished) observeTerminal("aborted");
        });

        return reply.send(stream);
      },
    );
  };

  return fp(plugin, { encapsulate: true, name: "admin-assets-plugin" });
}

export default createAdminAssetPlugin();
