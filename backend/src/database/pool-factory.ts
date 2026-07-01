import { Pool, type PoolConfig } from "pg";

export type DatabaseConfig = {
  pool: {
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
    statementTimeoutMillis: number;
  };
  sslMode: "disable" | "require" | "no-verify";
  url?: string;
};

type CreateDatabasePoolOptions = {
  database: DatabaseConfig;
};

function getSharedPoolConfig(
  databaseConfig: DatabaseConfig,
): Pick<
  PoolConfig,
  | "connectionTimeoutMillis"
  | "idleTimeoutMillis"
  | "max"
  | "ssl"
  | "statement_timeout"
> {
  return {
    connectionTimeoutMillis: databaseConfig.pool.connectionTimeoutMillis,
    idleTimeoutMillis: databaseConfig.pool.idleTimeoutMillis,
    max: databaseConfig.pool.max,
    ssl: buildSslConfig(databaseConfig.sslMode),
    statement_timeout: databaseConfig.pool.statementTimeoutMillis
  };
}

function buildSslConfig(databaseSslMode: DatabaseConfig["sslMode"]) {
  switch (databaseSslMode) {
    case "disable":
      return undefined;
    case "no-verify":
      return { rejectUnauthorized: false };
    case "require":
      return { rejectUnauthorized: true };
  }
}

function createPostgresPool(databaseConfig: DatabaseConfig) {
  if (!databaseConfig.url) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    ...getSharedPoolConfig(databaseConfig),
    connectionString: databaseConfig.url
  });
}

export function createDatabasePoolFromConfig(
  options: CreateDatabasePoolOptions,
) {
  return createPostgresPool(options.database);
}
