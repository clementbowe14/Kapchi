import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const paymentsPlugin: FastifyPluginAsync = async () => {};

export default fp(paymentsPlugin, {
  name: "payments-module"
});
