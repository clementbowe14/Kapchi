import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const usersPlugin: FastifyPluginAsync = async () => {};

export default fp(usersPlugin, {
  name: "users-module"
});
