import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "../config/index.js";

declare module "fastify" {
  interface FastifyInstance {
    pg: Pool;
    withPgClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  }
}

function buildSslConfig() {
  switch (config.database.sslMode) {
    case "disable":
      return undefined;
    case "no-verify":
      return { rejectUnauthorized: false };
    case "require":
      return { rejectUnauthorized: true };
  }
}

const postgresPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = new Pool({
    connectionString: config.database.url,
    connectionTimeoutMillis: config.database.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
    max: config.database.pool.max,
    ssl: buildSslConfig(),
    statement_timeout: config.database.pool.statementTimeoutMillis
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
