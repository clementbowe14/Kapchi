import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../config/index.js";
import { createDatabasePoolFromConfig } from "../database/pool-factory.js";

declare module "fastify" {
  interface FastifyInstance {
    pg: ReturnType<typeof createDatabasePoolFromConfig>;
    withPgClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  }
}

function getSafePostgresError(error: unknown) {
  if (!(error instanceof Error)) {
    return { message: "Unknown PostgreSQL error" };
  }

  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name
  };
}

const postgresPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = createDatabasePoolFromConfig({
    database: config.database
  });

  pool.on("error", (error) => {
    fastify.log.error(
      { err: getSafePostgresError(error) },
      "PostgreSQL pool error",
    );
  });

  let readinessCheck: QueryResult<QueryResultRow>;

  try {
    readinessCheck = await pool.query("select 1");
  } catch (error) {
    fastify.log.error(
      {
        err: getSafePostgresError(error),
        databaseMaxConnections:
          config.database.deployment.databaseMaxConnections,
        maxAppInstances: config.database.deployment.maxAppInstances,
        poolMax: config.database.pool.max,
        reservedConnections: config.database.deployment.reservedConnections,
        sslMode: config.database.sslMode
      },
      "PostgreSQL readiness check failed",
    );
    throw error;
  }

  fastify.log.info(
    {
      databaseMaxConnections: config.database.deployment.databaseMaxConnections,
      idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
      maxAppInstances: config.database.deployment.maxAppInstances,
      poolMax: config.database.pool.max,
      readinessRowCount: readinessCheck.rowCount,
      reservedConnections: config.database.deployment.reservedConnections,
      sslMode: config.database.sslMode,
      statementTimeoutMillis: config.database.pool.statementTimeoutMillis
    },
    "PostgreSQL pool configured",
  );

  fastify.decorate("pg", pool);
  fastify.decorate("withPgClient", async (callback) => {
    const client = await pool.connect();

    try {
      return await callback(client);
    } finally {
      client.release();
    }
  });

  fastify.addHook("onClose", async () => {
    await pool.end();
  });
};

export default fp(postgresPlugin, {
  name: "postgres-plugin"
});
