import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { safeErrorDetails } from "../../observability/safe-error.js";
import { verifyClerkToken } from "./jwt.js";

function extractBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const match = authorization.trim().match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export const authMiddleware: preHandlerHookHandler = async (request, reply) => {
  request.auth = null;

  const authorization = request.headers.authorization;
  const token = extractBearerToken(request);

  if (!token) {
    if (authorization) {
      return unauthorized(
        request,
        reply,
        "Authorization must use a valid Bearer token.",
      );
    }
    return;
  }

  try {
    request.auth = await verifyClerkToken(token);
  } catch (error) {
    request.log.warn(
      {
        event: "auth.token.rejected",
        ...safeErrorDetails(error)
      },
      "Bearer token was rejected",
    );
    return unauthorized(request, reply, "Bearer token is invalid or expired.");
  }
};

export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  if (!request.auth) {
    return unauthorized(request, reply, "Authentication is required.");
  }
};

export function requireRole(role: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.auth) {
      return unauthorized(request, reply, "Authentication is required.");
    }

    if (!request.auth.roles.includes(role)) {
      return forbidden(request, reply, `Missing required role: ${role}`);
    }
  };
}

export function requirePermission(permission: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.auth) {
      return unauthorized(request, reply, "Authentication is required.");
    }

    if (!request.auth.permissions.includes(permission)) {
      return forbidden(request, reply, `Missing required permission: ${permission}`);
    }
  };
}

function unauthorized(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(401).send({
    error: "UNAUTHORIZED",
    message,
    requestId: request.id,
    statusCode: 401
  });
}

function forbidden(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(403).send({
    error: "FORBIDDEN",
    message,
    requestId: request.id,
    statusCode: 403
  });
}
