import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { Pool, type PoolConfig } from "pg";

export type DatabaseConfig = {
  auroraDsql: {
    authMode?: "admin" | "custom";
    database: string;
    host?: string;
    tokenExpiresInSeconds: number;
    user?: string;
  };
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  mode: "local-postgres" | "aurora-dsql";
  poolMax: number;
  url?: string;
};

type CreateDatabasePoolOptions = {
  awsRegion: string;
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

function createLocalPostgresPool(databaseConfig: DatabaseConfig) {
  if (!databaseConfig.url) {
    throw new Error("DATABASE_URL is required when DATABASE_MODE=local-postgres");
  }

  return new Pool({
    ...getSharedPoolConfig(databaseConfig),
    connectionString: databaseConfig.url
  });
}

function createAuroraDsqlPool({
  awsRegion,
  database
}: CreateDatabasePoolOptions) {
  const dsqlConfig = database.auroraDsql;

  if (!dsqlConfig.host) {
    throw new Error("DSQL_HOST is required when DATABASE_MODE=aurora-dsql");
  }

  if (!dsqlConfig.user) {
    throw new Error("DSQL_USER is required when DATABASE_MODE=aurora-dsql");
  }

  if (!dsqlConfig.authMode) {
    throw new Error("DSQL_AUTH_MODE is required when DATABASE_MODE=aurora-dsql");
  }

  const signer = new DsqlSigner({
    expiresIn: dsqlConfig.tokenExpiresInSeconds,
    hostname: dsqlConfig.host,
    region: awsRegion
  });

  return new Pool({
    ...getSharedPoolConfig(database),
    database: dsqlConfig.database,
    host: dsqlConfig.host,
    password: () =>
      dsqlConfig.authMode === "admin"
        ? signer.getDbConnectAdminAuthToken()
        : signer.getDbConnectAuthToken(),
    port: 5432,
    ssl: true,
    user: dsqlConfig.user
  });
}

export function createDatabasePoolFromConfig(
  options: CreateDatabasePoolOptions,
) {
  return options.database.mode === "aurora-dsql"
    ? createAuroraDsqlPool(options)
    : createLocalPostgresPool(options.database);
}

