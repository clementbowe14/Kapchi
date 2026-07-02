import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabasePoolFromConfig,
  type DatabaseConfig
} from "./pool-factory.js";

const mocks = vi.hoisted(() => {
  const poolConfigs: unknown[] = [];

  class PoolMock {
    readonly config: unknown;

    constructor(config: unknown) {
      this.config = config;
      poolConfigs.push(config);
    }
  }

  return {
    PoolMock,
    poolConfigs
  };
});

vi.mock("pg", () => ({
  Pool: mocks.PoolMock
}));

function createBaseDatabaseConfig(
  overrides: Partial<DatabaseConfig> = {},
): DatabaseConfig {
  return {
    pool: {
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 10,
      statementTimeoutMillis: 15000
    },
    sslMode: "disable",
    url: "postgresql://kapchi:password@localhost:5432/kapchi_dev",
    ...overrides
  };
}

describe("createDatabasePoolFromConfig", () => {
  beforeEach(() => {
    mocks.poolConfigs.length = 0;
  });

  it("creates a Postgres pool from DATABASE_URL", () => {
    createDatabasePoolFromConfig({
      database: createBaseDatabaseConfig()
    });

    expect(mocks.poolConfigs).toEqual([
      {
        connectionString:
          "postgresql://kapchi:password@localhost:5432/kapchi_dev",
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10,
        ssl: undefined,
        statement_timeout: 15000
      }
    ]);
  });

  it("enables verified TLS when SSL mode is require", () => {
    createDatabasePoolFromConfig({
      database: createBaseDatabaseConfig({ sslMode: "require" })
    });

    expect(mocks.poolConfigs).toEqual([
      expect.objectContaining({
        ssl: { rejectUnauthorized: true }
      })
    ]);
  });

  it("enables non-verifying TLS when SSL mode is no-verify", () => {
    createDatabasePoolFromConfig({
      database: createBaseDatabaseConfig({ sslMode: "no-verify" })
    });

    expect(mocks.poolConfigs).toEqual([
      expect.objectContaining({
        ssl: { rejectUnauthorized: false }
      })
    ]);
  });

  it("requires DATABASE_URL", () => {
    expect(() =>
      createDatabasePoolFromConfig({
        database: createBaseDatabaseConfig({ url: undefined })
      }),
    ).toThrow("DATABASE_URL is required");
  });
});
