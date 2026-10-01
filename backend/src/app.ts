import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import * as fastify from "fastify";
import { config } from "./config/index.js";
import { closeDatabasePool } from "./database/index.js";
import adminAnalyticsPlugin from "./modules/admin-analytics/plugin.js";
import { authPlugin } from "./modules/auth/index.js";
import assetsPlugin from "./modules/assets/plugin.js";
import cartPlugin from "./modules/cart/plugin.js";
import healthPlugin from "./modules/health/plugin.js";
import listingsPlugin from "./modules/listings/plugin.js";
import ordersPlugin from "./modules/orders/plugin.js";
import paymentsPlugin from "./modules/payments/plugin.js";
import refundsPlugin from "./modules/refunds/plugin.js";
import shippingPlugin from "./modules/shipping/plugin.js";
import usersPlugin from "./modules/users/plugin.js";
import { createLoggerOptions } from "./observability/logger.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import postgresPlugin from "./plugins/postgres.js";
import redisPlugin from "./plugins/redis.js";
import requestObservabilityPlugin, {
  generateRequestId
} from "./plugins/request-observability.js";

export async function buildServer() {
  const app = fastify.fastify({
    disableRequestLogging: true,
    genReqId: generateRequestId,
    logger: createLoggerOptions(config.app.logLevel),
    requestIdLogLabel: "requestId"
  });

  await app.register(requestObservabilityPlugin);

  await app.register(cors, {
    credentials: true,
    origin: true
  });

  await app.register(helmet);
  await app.register(sensible);
  await app.register(cookie);
  await app.register(postgresPlugin);
  await app.register(redisPlugin);

  app.addHook("onClose", async () => {
    await closeDatabasePool();
  });

  await app.register(authPlugin);
  await app.register(healthPlugin);

  await app.register(adminAnalyticsPlugin, { prefix: "/admin/analytics" });
  await app.register(assetsPlugin, { prefix: "/assets" });
  await app.register(usersPlugin, { prefix: "/users" });
  await app.register(listingsPlugin, { prefix: "/listings" });
  await app.register(cartPlugin, { prefix: "/cart" });
  await app.register(ordersPlugin);
  await app.register(paymentsPlugin, { prefix: "/payments" });
  await app.register(refundsPlugin, { prefix: "/admin" });
  await app.register(shippingPlugin, { prefix: "/shipping" });

  registerErrorHandler(app);

  return app;
}
