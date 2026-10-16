import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import {
  ADMIN_CAPABILITY_MATRIX,
  type AdminCapability
} from "./capabilities.js";
import { hasMatchingAdminGuard } from "./guards.js";

function isAdminPath(url: string) {
  return url === "/admin" || url.startsWith("/admin/");
}

const adminBoundaryPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRoute", (route) => {
    if (!isAdminPath(route.url)) return;

    const capability = route.config?.adminCapability;
    if (
      typeof capability !== "string" ||
      !(capability in ADMIN_CAPABILITY_MATRIX) ||
      !hasMatchingAdminGuard(route.preHandler, capability as AdminCapability)
    ) {
      throw new Error(
        `Admin route ${route.method} ${route.url} is missing its admin capability guard.`,
      );
    }
  });
};

export default fp(adminBoundaryPlugin, {
  name: "admin-authorization-boundary"
});
