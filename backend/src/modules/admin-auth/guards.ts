import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler
} from "fastify";
import { authMiddleware } from "../auth/index.js";
import {
  hasAdminCapability,
  type AdminCapability
} from "./capabilities.js";

const ADMIN_GUARD_MARKER = Symbol("kapchi.admin-capability-guard");

type MarkedAdminGuard = preHandlerHookHandler & {
  [ADMIN_GUARD_MARKER]: AdminCapability;
};

function authError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 401 | 403,
  error: "UNAUTHORIZED" | "FORBIDDEN",
  message: string,
) {
  return reply.code(statusCode).send({
    error,
    message,
    requestId: request.id,
    statusCode
  });
}

export function requireAdminCapability(
  capability: AdminCapability,
): preHandlerHookHandler {
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      return authError(
        request,
        reply,
        401,
        "UNAUTHORIZED",
        "Authentication is required.",
      );
    }

    if (!hasAdminCapability(request.auth, capability)) {
      return authError(
        request,
        reply,
        403,
        "FORBIDDEN",
        "Verified store administrator access is required.",
      );
    }
  };

  Object.defineProperty(guard, ADMIN_GUARD_MARKER, {
    value: capability
  });
  return guard as unknown as MarkedAdminGuard;
}

export function hasMatchingAdminGuard(
  preHandler: unknown,
  capability: AdminCapability,
) {
  const handlers = Array.isArray(preHandler) ? preHandler : [preHandler];
  return handlers.some(
    (handler) =>
      typeof handler === "function" &&
      (handler as Partial<MarkedAdminGuard>)[ADMIN_GUARD_MARKER] === capability,
  );
}

export function adminRoute(capability: AdminCapability) {
  return {
    config: { adminCapability: capability },
    preHandler: [authMiddleware, requireAdminCapability(capability)]
  };
}
