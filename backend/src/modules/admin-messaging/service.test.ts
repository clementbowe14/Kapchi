import { describe, expect, it, vi } from "vitest";
import { MessageProviderError } from "./errors.js";
import { AdminMessagingService, type MessagingRepositoryPort } from "./service.js";

function dependencies() {
  const job = {
    attemptCount: 1,
    jobId: "98bdb51b-cacc-4d29-a8d9-a03f49c64565",
    maxAttempts: 5,
    message: {
      body: "private customer content",
      channel: "email" as const,
      from: "support@example.test",
      idempotencyKey: "delivery-key",
      messageId: "56ff2e8a-5438-4a23-b2de-35a344c4de24",
      subject: "Order update",
      threadKey: "kapchi-order:order-id",
      to: "customer@example.test"
    }
  };
  const repository = {
    addNote: vi.fn(),
    claimDeliveryJobs: vi.fn().mockResolvedValue([job]),
    completeDelivery: vi.fn().mockResolvedValue(true),
    detail: vi.fn(),
    failDelivery: vi.fn().mockResolvedValue(true),
    list: vi.fn(),
    queueReply: vi.fn(),
    receiveWebhook: vi.fn(),
    resolveActor: vi.fn(),
    scheduleRefundNotification: vi.fn().mockResolvedValue(true),
    scheduleRefundNotifications: vi.fn().mockResolvedValue({ attempted: 0, scheduled: 0 }),
    updateConversation: vi.fn()
  } as unknown as MessagingRepositoryPort;
  const provider = { send: vi.fn().mockResolvedValue({ messageId: "provider-id", provider: "sandbox" }) };
  const observer = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const service = new AdminMessagingService(
    repository,
    provider,
    { email: "support@example.test" },
    observer,
  );
  return { job, observer, provider, repository, service };
}

describe("AdminMessagingService", () => {
  it("delivers claimed jobs and records only safe observability fields", async () => {
    const { job, observer, provider, repository, service } = dependencies();

    await expect(service.runDelivery()).resolves.toMatchObject({ delivered: 1, failed: 0 });
    expect(provider.send).toHaveBeenCalledWith(job.message);
    expect(repository.completeDelivery).toHaveBeenCalledOnce();
    expect(JSON.stringify(observer.info.mock.calls)).not.toContain(job.message.body);
    expect(JSON.stringify(observer.info.mock.calls)).not.toContain(job.message.to);
  });

  it("releases transient failures for retry without logging private content", async () => {
    const { job, observer, provider, repository, service } = dependencies();
    provider.send.mockRejectedValueOnce(new MessageProviderError("GATEWAY_TIMEOUT", true));

    await expect(service.runDelivery()).resolves.toMatchObject({ retrying: 1 });
    expect(repository.failDelivery).toHaveBeenCalledWith(
      job,
      expect.any(String),
      "MESSAGE_PROVIDER_TIMEOUT",
      true,
    );
    expect(JSON.stringify(observer.warn.mock.calls)).not.toContain(job.message.body);
  });

  it("runs reconciliation, refund promotion, and materialization before delivery", async () => {
    const { observer, provider, repository } = dependencies();
    const order: string[] = [];
    repository.claimDeliveryJobs = vi.fn(async () => {
      order.push("delivery");
      return [];
    });
    const notifications = {
      list: vi.fn(),
      listForOrder: vi.fn(),
      materializeIntents: vi.fn().mockImplementation(async () => {
        order.push("materialize");
        return { attempted: 1, queued: 1 };
      }),
      promoteRefundEffect: vi.fn(),
      promoteRefundEffects: vi.fn().mockImplementation(async () => {
        order.push("refunds");
        return { attempted: 1, scheduled: 1 };
      }),
      reconcileLifecycle: vi.fn().mockImplementation(async () => {
        order.push("reconcile");
        return { attempted: 1, scheduled: 1 };
      })
    };
    const service = new AdminMessagingService(
      repository,
      provider,
      { email: "support@example.test" },
      observer,
      notifications,
    );

    await expect(service.runDelivery()).resolves.toMatchObject({
      materialization: { queued: 1 },
      refundNotifications: { scheduled: 1 }
    });
    expect(order).toEqual(["reconcile", "refunds", "materialize", "delivery"]);
  });

  it("continues later worker phases after a safe phase failure", async () => {
    const { observer, provider, repository } = dependencies();
    const notifications = {
      list: vi.fn(),
      listForOrder: vi.fn(),
      materializeIntents: vi.fn().mockResolvedValue({ attempted: 0, queued: 0 }),
      promoteRefundEffect: vi.fn(),
      promoteRefundEffects: vi.fn().mockResolvedValue({ attempted: 0, scheduled: 0 }),
      reconcileLifecycle: vi.fn().mockRejectedValue(new Error("private database detail"))
    };
    const service = new AdminMessagingService(
      repository,
      provider,
      { email: "support@example.test" },
      observer,
      notifications,
    );

    await expect(service.runDelivery()).resolves.toMatchObject({
      delivered: 1,
      lifecycle: { attempted: 0, failed: 1 }
    });
    expect(notifications.promoteRefundEffects).toHaveBeenCalledOnce();
    expect(notifications.materializeIntents).toHaveBeenCalledOnce();
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain("private database detail");
  });

  it("does not report provider acceptance as completed after losing the lease", async () => {
    const { observer, repository, service } = dependencies();
    repository.completeDelivery = vi.fn().mockResolvedValue(false);

    await expect(service.runDelivery()).resolves.toMatchObject({ delivered: 0 });
    expect(observer.warn).toHaveBeenCalledWith(
      "message.delivery.lease_lost",
      expect.objectContaining({ resultCode: "MESSAGE_LEASE_LOST" }),
    );
  });

  it("contains refund notification scheduling failures", async () => {
    const { observer, repository, service } = dependencies();
    repository.scheduleRefundNotification = vi.fn().mockRejectedValue(new Error("database secret"));

    await expect(service.scheduleRefundNotification("refund-id")).resolves.toBe(false);
    expect(observer.error).toHaveBeenCalledWith(
      "message.refund_notification.failed",
      expect.objectContaining({ operationId: "refund-id" }),
    );
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain("database secret");
  });
});
