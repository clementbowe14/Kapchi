import type { AdminCapability } from "./capabilities.js";

declare module "fastify" {
  interface FastifyContextConfig {
    adminCapability?: AdminCapability;
  }
}

export {};
