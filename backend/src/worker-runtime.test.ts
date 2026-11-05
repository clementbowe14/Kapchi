import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerLoops } from "./worker-runtime.js";

describe("worker runtime", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps independent operations running after one fails", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const info = vi.fn();
    const failing = vi.fn().mockRejectedValue(new Error("BOUNDED_FAILURE"));
    const healthy = vi.fn().mockResolvedValue(undefined);
    const stop = startWorkerLoops([
      { intervalMs: 1_000, name: "failing", run: failing, timeoutMs: 100 },
      { intervalMs: 1_000, name: "healthy", run: healthy, timeoutMs: 100 }
    ], { error, info });
    await vi.runOnlyPendingTimersAsync();
    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "BOUNDED_FAILURE", operation: "failing" }));
    await stop();
  });
});
