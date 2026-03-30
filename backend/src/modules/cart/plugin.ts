import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const cartPlugin: FastifyPluginAsync = async () => {};

export default fp(cartPlugin, {
  name: "cart-module"
});
