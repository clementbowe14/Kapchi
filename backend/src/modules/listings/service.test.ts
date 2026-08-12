import { describe, expect, it, vi } from "vitest";
import { ListingsUnavailableError } from "./errors.js";
import { ListingsService, isTransientPostgresError } from "./service.js";

function logger() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("ListingsService database retry policy", () => {
  it("retries recognized transient SQLSTATEs and stops after success", async () => {
    const listGraduationStoles = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("serialization"), { code: "40001" }))
      .mockResolvedValueOnce([]);
    const log = logger();
    const delay = vi.fn(async () => undefined);
    const service = new ListingsService(
      { getGraduationStole: vi.fn(), listGraduationStoles },
      log as never,
      { baseDelayMs: 10, delay, random: () => 0 },
    );

    await expect(service.list("request-1")).resolves.toEqual([]);
    expect(listGraduationStoles).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uses at most two retries for transient failures", async () => {
    const failure = Object.assign(new Error("connection"), { code: "08006" });
    const listGraduationStoles = vi.fn().mockRejectedValue(failure);
    const log = logger();
    const delay = vi.fn(async () => undefined);
    const service = new ListingsService(
      { getGraduationStole: vi.fn(), listGraduationStoles },
      log as never,
      { delay, random: () => 0.5 },
    );

    await expect(service.list("request-2")).rejects.toBeInstanceOf(
      ListingsUnavailableError,
    );
    expect(listGraduationStoles).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("does not retry permanent database failures", async () => {
    const listGraduationStoles = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("missing relation"), { code: "42P01" }));
    const log = logger();
    const delay = vi.fn(async () => undefined);
    const service = new ListingsService(
      { getGraduationStole: vi.fn(), listGraduationStoles },
      log as never,
      { delay },
    );

    await expect(service.list("request-3")).rejects.toBeInstanceOf(
      ListingsUnavailableError,
    );
    expect(listGraduationStoles).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("does not retry or log a normal not-found result", async () => {
    const getGraduationStole = vi.fn().mockResolvedValue(null);
    const log = logger();
    const service = new ListingsService(
      { getGraduationStole, listGraduationStoles: vi.fn() },
      log as never,
    );

    await expect(service.detail("request-4", "missing")).rejects.toMatchObject({
      name: "ListingNotFoundError"
    });
    expect(getGraduationStole).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("recognizes only the explicit PostgreSQL transient allowlist", () => {
    expect(isTransientPostgresError({ code: "40P01" })).toBe(true);
    expect(isTransientPostgresError({ code: "42P01" })).toBe(false);
    expect(isTransientPostgresError(new Error("network"))).toBe(false);
  });

  it("rejects retry configurations beyond the request budget", () => {
    expect(
      () =>
        new ListingsService(
          { getGraduationStole: vi.fn(), listGraduationStoles: vi.fn() },
          logger() as never,
          { maxAttempts: 4 },
        ),
    ).toThrow("maxAttempts must be between 1 and 3");
  });
});
