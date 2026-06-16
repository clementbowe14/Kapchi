import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabasePoolFromConfig,
  type DatabaseConfig
} from "./pool-factory.js";

const mocks = vi.hoisted(() => {
  const poolConfigs: unknown[] = [];
  const signerConfigs: unknown[] = [];
  const getDbConnectAuthToken = vi.fn().mockResolvedValue("custom-auth-token");
  const getDbConnectAdminAuthToken = vi
    .fn()
    .mockResolvedValue("admin-auth-token");

  class PoolMock {
    readonly config: unknown;

    constructor(config: unknown) {
      this.config = config;
      poolConfigs.push(config);
    }
  }

  class DsqlSignerMock {
    readonly config: unknown;

    constructor(config: unknown) {
      this.config = config;
      signerConfigs.push(config);
    }

    getDbConnectAuthToken = getDbConnectAuthToken;
    getDbConnectAdminAuthToken = getDbConnectAdminAuthToken;
  }

  return {
    DsqlSignerMock,
    PoolMock,
    getDbConnectAdminAuthToken,
    getDbConnectAuthToken,
    poolConfigs,
    signerConfigs
  };
});

vi.mock("pg", () => ({
  Pool: mocks.PoolMock
}));

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: mocks.DsqlSignerMock
}));

function createBaseDatabaseConfig(
  overrides: Partial<DatabaseConfig> = {},
): DatabaseConfig {
  return {
    auroraDsql: {
      database: "postgres",
      tokenExpiresInSeconds: 3600
    },
    connectionTimeoutMs: 10000,
    idleTimeoutMs: 30000,
    mode: "local-postgres",
    poolMax: 10,
    url: "postgresql://kapchi:password@localhost:5432/kapchi_dev",
    ...overrides
  };
}

describe("createDatabasePoolFromConfig", () => {
  beforeEach(() => {
    mocks.poolConfigs.length = 0;
    mocks.signerConfigs.length = 0;
    mocks.getDbConnectAuthToken.mockClear();
    mocks.getDbConnectAdminAuthToken.mockClear();
  });

  it("creates a local Postgres pool from DATABASE_URL", () => {
    createDatabasePoolFromConfig({
      awsRegion: "us-east-1",
      database: createBaseDatabaseConfig()
    });

    expect(mocks.poolConfigs).toEqual([
      {
        connectionString:
          "postgresql://kapchi:password@localhost:5432/kapchi_dev",
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10
      }
    ]);
    expect(mocks.signerConfigs).toEqual([]);
  });

  it("requires DATABASE_URL in local Postgres mode", () => {
    expect(() =>
      createDatabasePoolFromConfig({
        awsRegion: "us-east-1",
        database: createBaseDatabaseConfig({ url: undefined })
      }),
    ).toThrow("DATABASE_URL is required when DATABASE_MODE=local-postgres");
  });

  it("creates an Aurora DSQL pool with a custom role auth token callback", async () => {
    createDatabasePoolFromConfig({
      awsRegion: "us-east-1",
      database: createBaseDatabaseConfig({
        auroraDsql: {
          authMode: "custom",
          database: "postgres",
          host: "cluster-id.dsql.us-east-1.on.aws",
          tokenExpiresInSeconds: 3600,
          user: "kapchi_app"
        },
        mode: "aurora-dsql"
      })
    });

    expect(mocks.signerConfigs).toEqual([
      {
        expiresIn: 3600,
        hostname: "cluster-id.dsql.us-east-1.on.aws",
        region: "us-east-1"
      }
    ]);

    const poolConfig = mocks.poolConfigs[0] as { password: () => Promise<string> };
    await expect(poolConfig.password()).resolves.toBe("custom-auth-token");
    expect(mocks.getDbConnectAuthToken).toHaveBeenCalledTimes(1);
    expect(mocks.getDbConnectAdminAuthToken).not.toHaveBeenCalled();
    expect(poolConfig).toMatchObject({
      connectionTimeoutMillis: 10000,
      database: "postgres",
      host: "cluster-id.dsql.us-east-1.on.aws",
      idleTimeoutMillis: 30000,
      max: 10,
      port: 5432,
      ssl: true,
      user: "kapchi_app"
    });
  });

  it("uses the admin DSQL auth token path when configured", async () => {
    createDatabasePoolFromConfig({
      awsRegion: "us-east-1",
      database: createBaseDatabaseConfig({
        auroraDsql: {
          authMode: "admin",
          database: "postgres",
          host: "cluster-id.dsql.us-east-1.on.aws",
          tokenExpiresInSeconds: 3600,
          user: "admin"
        },
        mode: "aurora-dsql"
      })
    });

    const poolConfig = mocks.poolConfigs[0] as { password: () => Promise<string> };
    await expect(poolConfig.password()).resolves.toBe("admin-auth-token");
    expect(mocks.getDbConnectAdminAuthToken).toHaveBeenCalledTimes(1);
    expect(mocks.getDbConnectAuthToken).not.toHaveBeenCalled();
  });

  it.each([
    ["DSQL_HOST", { host: undefined }],
    ["DSQL_USER", { user: undefined }],
    ["DSQL_AUTH_MODE", { authMode: undefined }]
  ])("requires %s in Aurora DSQL mode", (label, auroraOverride) => {
    expect(() =>
      createDatabasePoolFromConfig({
        awsRegion: "us-east-1",
        database: createBaseDatabaseConfig({
          auroraDsql: {
            authMode: "custom",
            database: "postgres",
            host: "cluster-id.dsql.us-east-1.on.aws",
            tokenExpiresInSeconds: 3600,
            user: "kapchi_app",
            ...auroraOverride
          },
          mode: "aurora-dsql"
        })
      }),
    ).toThrow(`${label} is required when DATABASE_MODE=aurora-dsql`);
  });
});

