import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { getDatabasePool } from "../../database/index.js";

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => ({
    service: "kapchi-backend",
    status: "ok"
  }));

  fastify.get("/ready", async () => {
    await getDatabasePool().query("select 1");

    return {
      service: "kapchi-backend",
      status: "ready"
    };
  });
};

export default fp(healthPlugin, {
  name: "health-plugin"
});
