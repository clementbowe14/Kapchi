import { randomUUID, timingSafeEqual } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config/index.js";
import { safeErrorDetails } from "../../observability/safe-error.js";
import {
  createScheduledOperations,
  scheduledOperationNames,
  type ScheduledOperations
} from "../../operations/scheduled.js";

type OperationsPluginOptions = {
  cronSecret?: string;
  lockTtlMs?: number;
  operations?: ScheduledOperations;
};

const releaseLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function authorized(header: string | undefined, secret: string | undefined) {
  if (!header || !secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SCHEDULED_OPERATION_TIMEOUT")), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const operationsPlugin: FastifyPluginAsync<OperationsPluginOptions> = async (fastify, options) => {
  const operations = options.operations ?? createScheduledOperations(fastify.log);
  const cronSecret = options.cronSecret ?? config.operations.cronSecret;
  const lockTtlMs = options.lockTtlMs ?? 55_000;

  for (const operationName of scheduledOperationNames) {
    fastify.get(`/internal/cron/${operationName}`, async (request, reply) => {
      if (!authorized(request.headers.authorization, cronSecret)) {
        return reply.code(401).send({ errorCode: "CRON_UNAUTHORIZED" });
      }

      const operation = operations[operationName];
      const lockKey = `kapchi:cron:${operationName}`;
      const lockToken = randomUUID();
      let acquired: string | null;
      try {
        acquired = await fastify.redis.set(lockKey, lockToken, { NX: true, PX: lockTtlMs });
      } catch (error) {
        fastify.log.error({
          error: safeErrorDetails(error),
          event: "cron.lock.acquire_failed",
          operation: operationName
        }, "Scheduled operation lock acquisition failed");
        return reply.code(503).send({ errorCode: "CRON_LOCK_UNAVAILABLE", operation: operationName });
      }
      if (acquired !== "OK") {
        fastify.log.info({ event: "cron.operation.skipped", operation: operationName }, "Scheduled operation already running");
        return reply.code(202).send({ operation: operationName, status: "already_running" });
      }

      const startedAt = Date.now();
      let releaseLock = true;
      fastify.log.info({ event: "cron.operation.started", operation: operationName }, "Scheduled operation started");
      try {
        const result = await withTimeout(operation.run(), operation.timeoutMs);
        fastify.log.info({
          durationMs: Date.now() - startedAt,
          operation: operationName,
          ...(operationName === "health" && typeof result === "object" && result ? result : {}),
          event: "cron.operation.succeeded"
        }, "Scheduled operation succeeded");
        return { operation: operationName, status: "succeeded" };
      } catch (error) {
        if (error instanceof Error && error.message === "SCHEDULED_OPERATION_TIMEOUT") {
          releaseLock = false;
        }
        fastify.log.error({
          durationMs: Date.now() - startedAt,
          error: safeErrorDetails(error),
          event: "cron.operation.failed",
          operation: operationName
        }, "Scheduled operation failed");
        return reply.code(503).send({ errorCode: "CRON_OPERATION_FAILED", operation: operationName });
      } finally {
        if (releaseLock) {
          try {
            await fastify.redis.eval(releaseLockScript, { arguments: [lockToken], keys: [lockKey] });
          } catch (error) {
            fastify.log.warn({
              error: safeErrorDetails(error),
              event: "cron.lock.release_failed",
              operation: operationName
            }, "Scheduled operation lock release failed");
          }
        }
      }
    });
  }
};

export default fp(operationsPlugin, { name: "operations-plugin" });
