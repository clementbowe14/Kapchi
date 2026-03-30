import type { AuthContext } from "../../types/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export {};
