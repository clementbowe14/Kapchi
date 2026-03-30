import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("auth", null);
};

export default fp(authPlugin, {
  name: "auth-plugin"
});
