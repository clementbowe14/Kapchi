import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow
} from "pg";
import { config } from "../config/index.js";
import { createDatabasePoolFromConfig } from "../database/pool-factory.js";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool;
    withPgClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  }
}

const postgresPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = createDatabasePoolFromConfig({
    database: config.database
  });

  pool.on("error", (error) => {
    fastify.log.error({ err: error }, "PostgreSQL pool error");
  });

  const readinessCheck: QueryResult<QueryResultRow> = await pool.query(
    "select 1",
  );

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
