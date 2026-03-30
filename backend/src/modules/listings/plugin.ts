import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const listingsPlugin: FastifyPluginAsync = async () => {};

export default fp(listingsPlugin, {
  name: "listings-module"
});
