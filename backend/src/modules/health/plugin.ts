import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../../config/index.js";

const healthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => ({
    service: "kapchi-backend",
    status: "ok"
  }));

  fastify.get("/ready", async () => {
    await fastify.pg.query("select 1");

    return {
      dependencies: {
        privateAssetProvider: config.assets.privateReads.vercel.token ||
          (config.assets.privateReads.vercel.oidcToken &&
            config.assets.privateReads.vercel.storeId)
          ? "ready"
          : "unconfigured"
      },
      service: "kapchi-backend",
      status: "ready"
    };
  });
};

export default fp(healthPlugin, {
  name: "health-plugin"
});
