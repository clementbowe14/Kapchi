import { Pool, type PoolConfig } from "pg";

export type DatabaseConfig = {
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  poolMax: number;
  url?: string;
};

type CreateDatabasePoolOptions = {
  database: DatabaseConfig;
};

function getSharedPoolConfig(
  databaseConfig: DatabaseConfig,
): Pick<PoolConfig, "connectionTimeoutMillis" | "idleTimeoutMillis" | "max"> {
  return {
    connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
    idleTimeoutMillis: databaseConfig.idleTimeoutMs,
    max: databaseConfig.poolMax
  };
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
