import fp from "fastify-plugin";
import { createClient } from "redis";
import type { FastifyPluginAsync } from "fastify";
import type { RedisClientType } from "redis";
import { config } from "../config/index.js";
import { safeErrorDetails } from "../observability/safe-error.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: RedisClientType;
  }
}

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = createClient({
    url: config.cache.redisUrl
  });

  redis.on("error", (error) => {
    fastify.log.error(
      { cacheError: safeErrorDetails(error) },
      "Redis client error",
    );
  });

  await redis.connect();

  fastify.decorate("redis", redis);

  fastify.addHook("onClose", async () => {
    await redis.quit();
  });
};

export default fp(redisPlugin, {
  name: "redis-plugin"
});
