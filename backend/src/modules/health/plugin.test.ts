import { describe, expect, it, vi } from "vitest";
import { createReadinessProbe } from "./plugin.js";

function readyChecks() {
  return {
    database: vi.fn(async () => undefined),
    redis: vi.fn(async () => undefined),
    migrations: vi.fn(async () => undefined),
    privateAssetProvider: vi.fn(async () => undefined)
  };
}

describe("readiness probe", () => {
  it("reports the fixed dependency contract", async () => {
    const probe = createReadinessProbe(readyChecks(), { cacheMs: 2_000, checkTimeoutMs: 50, overallTimeoutMs: 100 });
    await expect(probe()).resolves.toMatchObject({
      dependencies: { database: "ready", redis: "ready", migrations: "ready", privateAssetProvider: "ready" },
      failedDependencyCodes: [],
      status: "ready"
    });
  });

  it("redacts dependency failures and shares concurrent work", async () => {
    const checks = readyChecks();
    checks.database.mockRejectedValue(new Error("postgres://secret@host/database"));
    const probe = createReadinessProbe(checks, { cacheMs: 2_000, checkTimeoutMs: 50, overallTimeoutMs: 100 });
    const [first, second] = await Promise.all([probe(), probe()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ dependencies: { database: "unready" }, failedDependencyCodes: ["DATABASE_UNAVAILABLE"], status: "unready" });
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(checks.database).toHaveBeenCalledOnce();
  });

  it("bounds a hanging dependency", async () => {
    const checks = readyChecks();
    checks.redis.mockImplementation(() => new Promise(() => undefined));
    const probe = createReadinessProbe(checks, { cacheMs: 0, checkTimeoutMs: 5, overallTimeoutMs: 50 });
    await expect(probe()).resolves.toMatchObject({ failedDependencyCodes: ["READINESS_TIMEOUT"], status: "unready" });
    await expect(probe()).resolves.toMatchObject({ failedDependencyCodes: ["READINESS_TIMEOUT"], status: "unready" });
    expect(checks.redis).toHaveBeenCalledOnce();
  });
});
