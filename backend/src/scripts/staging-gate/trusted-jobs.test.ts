import { describe, expect, it, vi } from "vitest";
import { invokeTrustedJob } from "./trusted-jobs.js";

describe("trusted staging jobs", () => {
  it("retries only the idempotent already-running response within a bound", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(invokeTrustedJob({
      apiOrigin: "https://api.staging.kapchi.example",
      cronSecret: "staging-cron-secret-123",
      fetchImpl: fetchMock,
      operation: "refunds"
    })).resolves.toEqual({ attempts: 2, operation: "refunds", status: "succeeded" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({
      authorization: "Bearer staging-cron-secret-123"
    });
  });

  it("rejects Vercel protection and unknown operations", async () => {
    await expect(invokeTrustedJob({
      apiOrigin: "https://api.staging.kapchi.example",
      cronSecret: "staging-cron-secret-123",
      fetchImpl: vi.fn(async () => new Response(null, {
        headers: { "content-type": "text/html", server: "Vercel" },
        status: 401
      })),
      operation: "health"
    })).rejects.toThrow("protected by Vercel");
    await expect(invokeTrustedJob({
      apiOrigin: "https://api.staging.kapchi.example",
      cronSecret: "staging-cron-secret-123",
      operation: "unknown"
    })).rejects.toThrow("Unknown");
  });
});
