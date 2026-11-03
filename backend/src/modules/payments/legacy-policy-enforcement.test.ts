import { describe, expect, it, vi } from "vitest";
import { enforceLegacyPolicySessions } from "./legacy-policy-enforcement.js";

const candidate = {
  orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
  stripeCheckoutSessionId: "cs_test_legacy"
};

function createStore(initial = [candidate], remaining = initial) {
  return {
    listSessionBearingOrdersWithoutEvidence: vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(remaining),
    retireExpiredSession: vi.fn()
  };
}

function providerSession(status: string | null, paymentStatus = "unpaid") {
  return {
    expiresAt: new Date("2026-11-03T13:00:00.000Z"),
    id: candidate.stripeCheckoutSessionId,
    paymentStatus,
    status
  };
}

describe("legacy policy enforcement", () => {
  it("is read-only by default and reports a blocking result", async () => {
    const store = createStore();
    const provider = { expire: vi.fn(), retrieve: vi.fn() };

    const result = await enforceLegacyPolicySessions({
      expire: false,
      provider,
      store
    });

    expect(result).toEqual({
      discoveredCount: 1,
      failedCount: 0,
      remainingCount: 1,
      resultCode: "LEGACY_SESSIONS_REMAIN",
      retiredCount: 0
    });
    expect(provider.retrieve).not.toHaveBeenCalled();
    expect(provider.expire).not.toHaveBeenCalled();
    expect(store.retireExpiredSession).not.toHaveBeenCalled();
  });

  it("expires, confirms, and retires an open provider session", async () => {
    const store = createStore([candidate], []);
    const provider = {
      expire: vi.fn(),
      retrieve: vi.fn()
        .mockResolvedValueOnce(providerSession("open"))
        .mockResolvedValueOnce(providerSession("expired"))
    };

    const result = await enforceLegacyPolicySessions({
      expire: true,
      provider,
      store
    });

    expect(provider.expire).toHaveBeenCalledWith(candidate.stripeCheckoutSessionId);
    expect(provider.retrieve).toHaveBeenCalledTimes(2);
    expect(store.retireExpiredSession).toHaveBeenCalledWith(candidate.orderId, {
      expiresAt: new Date("2026-11-03T13:00:00.000Z"),
      sessionId: candidate.stripeCheckoutSessionId
    });
    expect(result).toEqual({
      discoveredCount: 1,
      failedCount: 0,
      remainingCount: 0,
      resultCode: "READY",
      retiredCount: 1
    });
  });

  it("retires an already-expired provider session without expiring it again", async () => {
    const store = createStore([candidate], []);
    const provider = {
      expire: vi.fn(),
      retrieve: vi.fn().mockResolvedValue(providerSession("expired"))
    };

    const result = await enforceLegacyPolicySessions({
      expire: true,
      provider,
      store
    });

    expect(provider.expire).not.toHaveBeenCalled();
    expect(store.retireExpiredSession).toHaveBeenCalledOnce();
    expect(result.resultCode).toBe("READY");
  });

  it("never retires a complete or paid session", async () => {
    const store = createStore([candidate], [candidate]);
    const provider = {
      expire: vi.fn(),
      retrieve: vi.fn().mockResolvedValue(providerSession("complete", "paid"))
    };

    const result = await enforceLegacyPolicySessions({
      expire: true,
      provider,
      store
    });

    expect(provider.expire).not.toHaveBeenCalled();
    expect(store.retireExpiredSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      failedCount: 1,
      remainingCount: 1,
      resultCode: "EXPIRATION_INCOMPLETE"
    });
    expect(JSON.stringify(result)).not.toContain(candidate.orderId);
    expect(JSON.stringify(result)).not.toContain(candidate.stripeCheckoutSessionId);
  });
});
