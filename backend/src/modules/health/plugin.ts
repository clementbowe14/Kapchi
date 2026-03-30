import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => ({
    service: "kapchi-backend",
    status: "ok"
  }));

  fastify.get("/ready", async () => ({
    service: "kapchi-backend",
    status: "ready"
  }));
};

export default fp(healthPlugin, {
  name: "health-plugin"
});
