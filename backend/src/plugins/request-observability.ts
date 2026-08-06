import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type {
  FastifyPluginAsync,
  FastifyRequest,
  RawRequestDefaultExpression
} from "fastify";
import fp from "fastify-plugin";
import { safeErrorDetails } from "../observability/safe-error.js";

export const REQUEST_ID_HEADER = "x-request-id";
const CORRELATION_ID_HEADER = "x-correlation-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type MonotonicClock = {
  now(): number;
};

type RequestObservabilityOptions = {
  clock?: MonotonicClock;
};

function validHeaderValue(value: string | string[] | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
}

export function generateRequestId(request: RawRequestDefaultExpression) {
  const headers = request.headers as IncomingHttpHeaders;

  return (
    validHeaderValue(headers[REQUEST_ID_HEADER]) ??
    validHeaderValue(headers[CORRELATION_ID_HEADER]) ??
    randomUUID()
  );
}

function safeRequestUrl(url: string) {
  return url.split("?", 1)[0] || "/";
}

function requestFields(
  request: FastifyRequest,
  statusCode: number,
  durationMs: number,
) {
  return {
    durationMs: Math.max(0, Math.round(durationMs * 1000) / 1000),
    method: request.method,
    requestId: request.id,
    route: request.routeOptions.url ?? null,
    statusCode,
    url: safeRequestUrl(request.url)
  };
}

function failureStatusCode(error: unknown, replyStatusCode: number) {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }

  return replyStatusCode >= 400 ? replyStatusCode : 500;
}

export function createRequestObservabilityPlugin({
  clock = { now: () => performance.now() }
}: RequestObservabilityOptions = {}) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const failureLogged = new WeakSet<FastifyRequest>();
    const startedAt = new WeakMap<FastifyRequest, number>();

    fastify.addHook("onRequest", async (request) => {
      startedAt.set(request, clock.now());
    });

    fastify.addHook("onSend", async (request, reply, payload) => {
      reply.header(REQUEST_ID_HEADER, request.id);
      return payload;
    });

    fastify.addHook("onError", async (request, reply, error) => {
      const start = startedAt.get(request) ?? clock.now();
      failureLogged.add(request);

      request.log.error(
        {
          event: "http.request.failed",
          ...requestFields(
            request,
            failureStatusCode(error, reply.statusCode),
            clock.now() - start,
          ),
          ...safeErrorDetails(error)
        },
        "HTTP request failed",
      );
    });

    fastify.addHook("onResponse", async (request, reply) => {
      const start = startedAt.get(request) ?? clock.now();
      const durationMs = clock.now() - start;

      if (reply.statusCode >= 500 && !failureLogged.has(request)) {
        request.log.error(
          {
            event: "http.request.failed",
            ...requestFields(request, reply.statusCode, durationMs)
          },
          "HTTP request failed",
        );
      }

      request.log.info(
        {
          event: "http.request.completed",
          ...requestFields(request, reply.statusCode, durationMs)
        },
        "HTTP request completed",
      );
      failureLogged.delete(request);
      startedAt.delete(request);
    });
  };

  return fp(plugin, { name: "request-observability" });
}

export default createRequestObservabilityPlugin();
