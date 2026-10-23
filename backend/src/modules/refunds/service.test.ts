import { describe, expect, it, vi } from "vitest";
import { RefundError, RefundProviderError } from "./errors.js";
import type { RefundProvider } from "./provider.js";
import type { StoredRefundOperation } from "./repository.js";
import { RefundService, type RefundRepositoryPort } from "./service.js";
import type { ProviderPaymentSnapshot, RefundActor, RefundRequest } from "./types.js";

const actor: RefundActor = {
  authSubject: "user_admin",
  userId: "02d8ff54-38c9-4420-a74c-b770916c6260"
};
const request: RefundRequest = {
  amountCents: 2500,
  currency: "usd",
  notificationRequested: true,
  reasonCode: "requested_by_customer",
  reasonNote: "Customer request",
  restockRequested: false
};
const snapshot: ProviderPaymentSnapshot = {
  apiVersion: "2026-02-25.clover",
  capturedAmountCents: 5000,
  currency: "usd",
  latestChargeId: "ch_test",
  livemode: false,
  paymentIntentId: "pi_test",
  providerAccountId: "acct_test",
  providerPaymentStatus: "succeeded",
  refunds: []
};

function pendingOperation(overrides: Partial<StoredRefundOperation> = {}): StoredRefundOperation {
  return {
    amountCents: 2500,
    clientIdempotencyKey: "refund-key",
    createdAt: new Date().toISOString(),
    currency: "usd",
    dispatchEverClaimed: false,
    failedAt: null,
    failureCode: null,
    id: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
    manualReviewRequired: false,
    nextReconciliationAt: new Date().toISOString(),
    notificationRequested: true,
    orderId: "719ddc98-6333-4ffd-8040-ce43ac569628",
    paymentIntentId: "pi_test",
    pendingReason: "reserved",
    providerAccountId: "acct_test",
    providerAttemptCount: 0,
    providerIdempotencyKey: "kapchi-refund:3de37830-b86f-43bb-a0b1-d6938b85ad59",
    providerRefundId: null,
    reasonCode: "requested_by_customer",
    requestFingerprint: "fingerprint",
    restockRequested: false,
    status: "pending",
    succeededAt: null,
    ...overrides
  };
}

function dependencies() {
  let stored: StoredRefundOperation | null = null;
  const repository = {
    applyProviderResult: vi.fn(async (_id, refund) => {
      stored = pendingOperation({
        pendingReason: refund.status === "succeeded" ? null : "provider_pending",
        providerRefundId: refund.id,
        status: refund.status === "succeeded" ? "succeeded" : "pending",
        succeededAt: refund.status === "succeeded" ? new Date().toISOString() : null
      });
      return stored;
    }),
    applyReconciliation: vi.fn(async () => ({ reconciliationStatus: "current" })),
    claimDispatch: vi.fn(async () => {
      stored = pendingOperation({ dispatchEverClaimed: true, providerAttemptCount: 1 });
      return stored;
    }),
    findByClientKey: vi.fn(async () => stored),
    getOperation: vi.fn(async () => stored),
    getOrderPaymentIntent: vi.fn(async () => ({ currency: "usd", paymentIntentId: "pi_test" })),
    claimRecoveryCandidates: vi.fn(async () => []),
    markReconciliationFailure: vi.fn(async () => undefined),
    markProviderError: vi.fn(async (_id, code, ambiguous) => {
      stored = pendingOperation({
        dispatchEverClaimed: true,
        failureCode: code,
        pendingReason: ambiguous ? "unknown_outcome" : null,
        status: ambiguous ? "pending" : "failed"
      });
      return stored;
    }),
    reserve: vi.fn(async (_orderId, _actor, _request, key, fingerprint) => {
      stored = pendingOperation({
        clientIdempotencyKey: key,
        requestFingerprint: fingerprint
      });
      return stored;
    }),
    resolveActor: vi.fn(async () => actor),
    summary: vi.fn()
  } as unknown as RefundRepositoryPort;
  const provider = {
    createRefund: vi.fn(async () => ({
      amountCents: 2500,
      chargeId: "ch_test",
      createdAt: new Date(),
      currency: "usd",
      failureCode: null,
      id: "re_test",
      livemode: false,
      metadata: { operationId: pendingOperation().id },
      paymentIntentId: "pi_test",
      status: "succeeded" as const
    })),
    reconcilePayment: vi.fn(async () => snapshot),
    retrieveRefund: vi.fn()
  } satisfies RefundProvider;
  return { provider, repository, setStored: (value: StoredRefundOperation) => { stored = value; } };
}

describe("RefundService", () => {
  it("reconciles, reserves, and dispatches one successful refund", async () => {
    const { provider, repository } = dependencies();
    const notificationScheduler = {
      scheduleRefundNotification: vi.fn().mockResolvedValue(true)
    };
    const service = new RefundService(
      repository,
      provider,
      undefined,
      notificationScheduler,
    );

    const result = await service.create(
      pendingOperation().orderId,
      actor,
      request,
      "new-refund-key",
    );

    expect(result.operation.status).toBe("succeeded");
    expect(repository.applyReconciliation).toHaveBeenCalledOnce();
    expect(repository.reserve).toHaveBeenCalledOnce();
    expect(provider.createRefund).toHaveBeenCalledOnce();
    expect(notificationScheduler.scheduleRefundNotification).toHaveBeenCalledWith(
      result.operation.id,
    );
  });

  it("does not fail a successful refund when notification scheduling fails", async () => {
    const { provider, repository } = dependencies();
    const notificationScheduler = {
      scheduleRefundNotification: vi.fn().mockRejectedValue(new Error("queue unavailable"))
    };
    const observer = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const service = new RefundService(
      repository,
      provider,
      observer,
      notificationScheduler,
    );

    const result = await service.create(
      pendingOperation().orderId,
      actor,
      request,
      "refund-with-notification-failure",
    );

    expect(result.operation.status).toBe("succeeded");
    expect(observer.error).toHaveBeenCalledWith(
      "refund.notification.scheduling_failed",
      expect.objectContaining({ resultCode: "MESSAGE_SCHEDULING_FAILED" }),
    );
  });

  it("returns a terminal idempotent replay without contacting Stripe", async () => {
    const { provider, repository, setStored } = dependencies();
    const service = new RefundService(repository, provider);
    const initial = pendingOperation();
    const first = await service.create(initial.orderId, actor, request, initial.clientIdempotencyKey);
    setStored({
      ...first.operation,
      dispatchEverClaimed: true,
      paymentIntentId: "pi_test",
      providerAccountId: "acct_test",
      providerAttemptCount: 1,
      providerIdempotencyKey: initial.providerIdempotencyKey,
      reasonCode: request.reasonCode,
      requestFingerprint: (repository.reserve as ReturnType<typeof vi.fn>).mock.calls[0][4]
    });
    provider.createRefund.mockClear();
    provider.reconcilePayment.mockClear();

    const replay = await service.create(initial.orderId, actor, request, initial.clientIdempotencyKey);

    expect(replay.replayed).toBe(true);
    expect(replay.operation.status).toBe("succeeded");
    expect(provider.createRefund).not.toHaveBeenCalled();
    expect(provider.reconcilePayment).not.toHaveBeenCalled();
  });

  it("keeps ambiguous provider failures pending and reserved", async () => {
    const { provider, repository } = dependencies();
    provider.createRefund.mockRejectedValue(
      new RefundProviderError("ETIMEDOUT", "unknown", true),
    );
    const service = new RefundService(repository, provider);

    const result = await service.create(
      pendingOperation().orderId,
      actor,
      request,
      "ambiguous-refund-key",
    );

    expect(result.operation).toMatchObject({
      failureCode: "ETIMEDOUT",
      pendingReason: "unknown_outcome",
      status: "pending"
    });
  });

  it("rejects reuse of a client key for different input", async () => {
    const { provider, repository, setStored } = dependencies();
    setStored(pendingOperation({ requestFingerprint: "different" }));
    const service = new RefundService(repository, provider);

    await expect(
      service.create(pendingOperation().orderId, actor, request, "refund-key"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(provider.createRefund).not.toHaveBeenCalled();
  });
});
