import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { verifyClerkToken } from "./jwt.js";

function extractBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export const authMiddleware: preHandlerHookHandler = async (request) => {
  request.auth = null;

  const token = extractBearerToken(request);

  if (!token) {
    return;
  }

  request.auth = await verifyClerkToken(token);
};

export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  if (!request.auth) {
    void unauthorized(reply, "Authentication is required.");
  }
};

export function requireRole(role: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.auth) {
      void unauthorized(reply, "Authentication is required.");
      return;
    }

    if (!request.auth.roles.includes(role)) {
      void forbidden(reply, `Missing required role: ${role}`);
    }
  };
}

export function requirePermission(permission: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.auth) {
      void unauthorized(reply, "Authentication is required.");
      return;
    }

    if (!request.auth.permissions.includes(permission)) {
      void forbidden(reply, `Missing required permission: ${permission}`);
    }
  };
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.code(401).send({
    error: "UNAUTHORIZED",
    message,
    statusCode: 401
  });
}

function forbidden(reply: FastifyReply, message: string) {
  return reply.code(403).send({
    error: "FORBIDDEN",
    message,
    statusCode: 403
  });
}
