import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "../config/index.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const serverCallbackRoutes = [
  /^\/assets\/upload-completions(?:\?|$)/,
  /^\/messaging\/webhooks\/[^/?]+(?:\?|$)/,
  /^\/payments\/webhooks\/stripe(?:\?|$)/,
  /^\/webhooks\/clerk(?:\?|$)/
];

export function isAllowedBrowserOrigin(origin: string | undefined, allowedOrigins: readonly string[]) {
  return origin === undefined || allowedOrigins.includes(origin);
}

export function requiresBrowserOrigin(request: Pick<FastifyRequest, "headers" | "method" | "url">) {
  if (safeMethods.has(request.method.toUpperCase())) return false;
  if (serverCallbackRoutes.some((pattern) => pattern.test(request.url))) return false;
  return true;
}

const originSecurityPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowed = isAllowedBrowserOrigin(origin, config.app.allowedOrigins);

    if (!allowed || (requiresBrowserOrigin(request) && !origin)) {
      request.log.warn({
        event: "http.origin.rejected",
        method: request.method,
        originPresent: Boolean(origin)
      }, "Request origin was rejected");
      return reply.code(403).send({
        error: "ORIGIN_FORBIDDEN",
        message: "Request origin is not allowed.",
        requestId: request.id,
        statusCode: 403
      });
    }
  });
};

export default fp(originSecurityPlugin, { name: "origin-security-plugin" });
