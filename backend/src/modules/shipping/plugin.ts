import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const shippingPlugin: FastifyPluginAsync = async () => {};

export default fp(shippingPlugin, {
  name: "shipping-module"
});
