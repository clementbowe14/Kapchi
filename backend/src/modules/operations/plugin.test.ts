import fastify from "fastify";
import type { RedisClientType } from "redis";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledOperations } from "../../operations/scheduled.js";
import operationsPlugin from "./plugin.js";

const secret = "c".repeat(32);

function operations(run: () => Promise<unknown> = vi.fn(async () => undefined), timeoutMs = 50): ScheduledOperations {
  return {
    health: { run, timeoutMs },
    inventory: { run, timeoutMs },
    maintenance: { run, timeoutMs },
    messages: { run, timeoutMs },
    refunds: { run, timeoutMs }
  };
}

async function build(overrides: { acquired?: string | null; lockError?: Error; run?: () => Promise<unknown>; timeoutMs?: number } = {}) {
  const app = fastify({ logger: false });
  const set = vi.fn(async () => {
    if (overrides.lockError) throw overrides.lockError;
    return overrides.acquired === undefined ? "OK" : overrides.acquired;
  });
  const evalLock = vi.fn(async () => 1);
  app.decorate("redis", { eval: evalLock, set } as unknown as RedisClientType);
  const run = overrides.run ?? vi.fn(async () => undefined);
  await app.register(operationsPlugin, { cronSecret: secret, operations: operations(run, overrides.timeoutMs) });
  return { app, evalLock, run, set };
}

describe("operations cron routes", () => {
  it("rejects missing and incorrect credentials before acquiring a lock", async () => {
    const { app, set } = await build();
    expect((await app.inject({ method: "GET", url: "/internal/cron/messages" })).statusCode).toBe(401);
    expect((await app.inject({ headers: { authorization: "Bearer wrong" }, method: "GET", url: "/internal/cron/messages" })).statusCode).toBe(401);
    expect(set).not.toHaveBeenCalled();
    await app.close();
  });

  it("runs an authorized operation once and releases its owned lock", async () => {
    const { app, evalLock, run, set } = await build();
    const response = await app.inject({ headers: { authorization: `Bearer ${secret}` }, method: "GET", url: "/internal/cron/messages" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operation: "messages", status: "succeeded" });
    expect(set).toHaveBeenCalledWith("kapchi:cron:messages", expect.any(String), { NX: true, PX: 55_000 });
    expect(run).toHaveBeenCalledOnce();
    expect(evalLock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("treats an overlapping invocation as an accepted no-op", async () => {
    const { app, run } = await build({ acquired: null });
    const response = await app.inject({ headers: { authorization: `Bearer ${secret}` }, method: "GET", url: "/internal/cron/refunds" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ operation: "refunds", status: "already_running" });
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a bounded failure without leaking the operation error", async () => {
    const { app, evalLock } = await build({ run: vi.fn(async () => { throw new Error("sensitive provider detail"); }) });
    const response = await app.inject({ headers: { authorization: `Bearer ${secret}` }, method: "GET", url: "/internal/cron/maintenance" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("sensitive provider detail");
    expect(evalLock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns a bounded lock failure without executing the operation", async () => {
    const { app, run } = await build({ lockError: new Error("redis endpoint detail") });
    const response = await app.inject({ headers: { authorization: `Bearer ${secret}` }, method: "GET", url: "/internal/cron/inventory" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ errorCode: "CRON_LOCK_UNAVAILABLE", operation: "inventory" });
    expect(response.body).not.toContain("redis endpoint detail");
    expect(run).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets a timed-out lock expire instead of releasing it while work may continue", async () => {
    const { app, evalLock } = await build({ run: () => new Promise(() => undefined), timeoutMs: 5 });
    const response = await app.inject({ headers: { authorization: `Bearer ${secret}` }, method: "GET", url: "/internal/cron/health" });
    expect(response.statusCode).toBe(503);
    expect(evalLock).not.toHaveBeenCalled();
    await app.close();
  });
});
