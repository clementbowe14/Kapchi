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
    connectionTimeoutMs: 10000,
    idleTimeoutMs: 30000,
    poolMax: 10,
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
        max: 10
      }
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
