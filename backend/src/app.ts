import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import * as fastify from "fastify";
import { config } from "./config/index.js";
import { closeDatabasePool } from "./database/index.js";
import adminAnalyticsPlugin from "./modules/admin-analytics/plugin.js";
import adminAssetsPlugin from "./modules/admin-assets/plugin.js";
import adminBoundaryPlugin from "./modules/admin-auth/boundary.js";
import adminInventoryPlugin from "./modules/admin-inventory/plugin.js";
import adminMessagingPlugin from "./modules/admin-messaging/plugin.js";
import adminOrdersPlugin from "./modules/admin-orders/plugin.js";
import { authPlugin } from "./modules/auth/index.js";
import assetsPlugin from "./modules/assets/plugin.js";
import cartPlugin from "./modules/cart/plugin.js";
import healthPlugin from "./modules/health/plugin.js";
import listingsPlugin from "./modules/listings/plugin.js";
import ordersPlugin from "./modules/orders/plugin.js";
import operationsPlugin from "./modules/operations/plugin.js";
import paymentsPlugin from "./modules/payments/plugin.js";
import refundsPlugin from "./modules/refunds/plugin.js";
import shippingPlugin from "./modules/shipping/plugin.js";
import usersPlugin from "./modules/users/plugin.js";
import { createLoggerOptions } from "./observability/logger.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import postgresPlugin from "./plugins/postgres.js";
import redisPlugin from "./plugins/redis.js";
import originSecurityPlugin, { isAllowedBrowserOrigin } from "./plugins/origin-security.js";
import requestObservabilityPlugin, {
  generateRequestId
} from "./plugins/request-observability.js";

export async function buildServer() {
  const app = fastify.fastify({
    genReqId: generateRequestId,
    logger: createLoggerOptions(config.app.logLevel),
    logController: new fastify.LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId"
    })
  });

  await app.register(requestObservabilityPlugin);

  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(null, isAllowedBrowserOrigin(origin, config.app.allowedOrigins) && Boolean(origin));
    }
  });

  await app.register(originSecurityPlugin);

  await app.register(helmet);
  await app.register(sensible);
  await app.register(cookie);
  await app.register(postgresPlugin);
  await app.register(redisPlugin);

  app.addHook("onClose", async () => {
    await closeDatabasePool();
  });

  await app.register(authPlugin);
  await app.register(adminBoundaryPlugin);
  await app.register(healthPlugin);
  await app.register(operationsPlugin);

  await app.register(adminAnalyticsPlugin, { prefix: "/admin/analytics" });
  await app.register(adminAssetsPlugin, { prefix: "/admin/orders" });
  await app.register(adminInventoryPlugin, { prefix: "/admin/inventory" });
  await app.register(adminMessagingPlugin);
  await app.register(adminOrdersPlugin, { prefix: "/admin/orders" });
  await app.register(assetsPlugin, { prefix: "/assets" });
  await app.register(usersPlugin, { prefix: "/users" });
  await app.register(listingsPlugin, { prefix: "/listings" });
  await app.register(cartPlugin, { prefix: "/cart" });
  await app.register(ordersPlugin);
  await app.register(paymentsPlugin, { prefix: "/payments" });
  await app.register(refundsPlugin, { prefix: "/admin" });
  await app.register(shippingPlugin, { prefix: "/admin" });

  registerErrorHandler(app);

  return app;
}
