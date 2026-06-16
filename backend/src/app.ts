import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import * as fastify from "fastify";
import { config } from "./config/index.js";
import { closeDatabasePool } from "./database/index.js";
import { authPlugin } from "./modules/auth/index.js";
import cartPlugin from "./modules/cart/plugin.js";
import healthPlugin from "./modules/health/plugin.js";
import listingsPlugin from "./modules/listings/plugin.js";
import paymentsPlugin from "./modules/payments/plugin.js";
import shippingPlugin from "./modules/shipping/plugin.js";
import usersPlugin from "./modules/users/plugin.js";
import { registerErrorHandler } from "./plugins/error-handler.js";

export async function buildServer() {
  const app = fastify.fastify({
    logger: {
      level: config.app.logLevel
    }
  });

  await app.register(cors, {
    origin: true
  });

  await app.register(helmet);
  await app.register(sensible);

  app.addHook("onClose", async () => {
    await closeDatabasePool();
  });

  await app.register(authPlugin);
  await app.register(healthPlugin);

  await app.register(usersPlugin, { prefix: "/users" });
  await app.register(listingsPlugin, { prefix: "/listings" });
  await app.register(cartPlugin, { prefix: "/cart" });
  await app.register(paymentsPlugin, { prefix: "/payments" });
  await app.register(shippingPlugin, { prefix: "/shipping" });

  registerErrorHandler(app);

  return app;
}
