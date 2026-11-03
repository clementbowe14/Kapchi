import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingRepositoryPort } from "./service.js";
import { signMessagingWebhook } from "./webhook-signature.js";

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: {
    auth: unknown;
    headers: { authorization?: string };
  }) => {
    const token = request.headers.authorization;
    request.auth = token
      ? {
          claims: {},
          permissions: [],
          roles: token === "Bearer admin-token" ? ["admin"] : ["customer"],
          sessionId: null,
          token,
          userId: token === "Bearer admin-token" ? "clerk_admin" : "clerk_customer"
        }
      : null;
  }
}));

const [{ default: adminBoundaryPlugin }, { createAdminMessagingPlugin }] = await Promise.all([
  import("../admin-auth/boundary.js"),
  import("./plugin.js")
]);

const orderId = "719ddc98-6333-4ffd-8040-ce43ac569628";
const message = {
  body: "Your order is ready.",
  channel: "email" as const,
  createdAt: "2026-10-22T12:00:00.000Z",
  direction: "outbound" as const,
  failedAt: null,
  failureCode: null,
  id: "56ff2e8a-5438-4a23-b2de-35a344c4de24",
  provider: null,
  sentAt: null,
  senderType: "admin" as const,
  status: "queued" as const,
  subject: "Order update"
};

function repository() {
  return {
    addNote: vi.fn().mockResolvedValue({ message: { ...message, channel: "internal_note", direction: "internal", status: "sent" }, replayed: false }),
    claimDeliveryJobs: vi.fn().mockResolvedValue([]),
    completeDelivery: vi.fn(),
    detail: vi.fn().mockResolvedValue({
      adminUnread: false,
      availableChannels: ["email"],
      capabilities: { attachments: false, email: true, sms: false },
      customerName: "Test Customer",
      lastMessageAt: null,
      messages: [],
      orderId,
      preferredChannel: "email",
      publicOrderNumber: "KAP-TEST",
      status: "awaiting_admin",
      version: 0
    }),
    failDelivery: vi.fn(),
    list: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
    queueReply: vi.fn().mockResolvedValue({ message, replayed: false }),
    receiveWebhook: vi.fn().mockResolvedValue({ duplicate: false, status: "processed" }),
    resolveActor: vi.fn().mockResolvedValue({
      authSubject: "clerk_admin",
      userId: "c33f2b22-2af9-4d03-b24b-f86e9b9b98a5"
    }),
    scheduleRefundNotification: vi.fn(),
    scheduleRefundNotifications: vi.fn().mockResolvedValue({ attempted: 0, scheduled: 0 }),
    updateConversation: vi.fn().mockResolvedValue({ status: "resolved", version: 1 })
  } as unknown as MessagingRepositoryPort;
}

function notificationOperations() {
  return {
    list: vi.fn().mockResolvedValue({
      notifications: [{
        channel: null,
        createdAt: "2026-11-03T12:00:00.000Z",
        deliveryAttemptCount: 0,
        failedAt: "2026-11-03T12:01:00.000Z",
        failureCode: "MESSAGE_CONTACT_UNAVAILABLE",
        id: "d7af78b8-14d8-4c1c-8058-e83be4a1b1f0",
        kind: "order.confirmed",
        materializationAttemptCount: 1,
        publicOrderNumber: "KAP-TEST",
        queuedAt: null,
        state: "failed",
        succeededAt: null,
        updatedAt: "2026-11-03T12:01:00.000Z"
      }]
    }),
    listForOrder: vi.fn().mockResolvedValue([]),
    materializeIntents: vi.fn(),
    promoteRefundEffect: vi.fn(),
    promoteRefundEffects: vi.fn(),
    reconcileLifecycle: vi.fn()
  };
}

async function server(repo: MessagingRepositoryPort) {
  const notifications = notificationOperations();
  const app = fastify({ logger: false });
  app.decorate("pg", {} as never);
  await app.register(adminBoundaryPlugin);
  await app.register(createAdminMessagingPlugin({
    messagingConfig: {
      delivery: { token: "test-token", url: "https://gateway.test/messages" },
      senders: { email: "support@example.test", sms: "+15555550100" },
      webhookSecret: "test-webhook-secret"
    },
    notificationOperationsFactory: () => notifications,
    providerFactory: () => ({ send: vi.fn() }),
    repositoryFactory: () => repo
  }));
  return { app, notifications };
}

describe("admin messaging plugin", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { authorization: undefined, statusCode: 401 },
    { authorization: "Bearer customer-token", statusCode: 403 }
  ])("protects conversation data with the shared admin boundary", async ({ authorization, statusCode }) => {
    const repo = repository();
    const { app } = await server(repo);
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "GET",
      url: "/admin/messages/conversations"
    });

    expect(response.statusCode).toBe(statusCode);
    expect(repo.list).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues an admin reply with verified actor and idempotency identity", async () => {
    const repo = repository();
    const { app } = await server(repo);
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "reply-once"
      },
      method: "POST",
      payload: { body: "Your order is ready.", channel: "email", subject: "Order update" },
      url: `/admin/messages/orders/${orderId}/replies`
    });

    expect(response.statusCode).toBe(202);
    expect(repo.queueReply).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ authSubject: "clerk_admin" }),
      expect.objectContaining({ channel: "email" }),
      "reply-once",
      expect.objectContaining({ email: "support@example.test" }),
    );
    await app.close();
  });

  it("stores internal notes through a separate operation", async () => {
    const repo = repository();
    const { app } = await server(repo);
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "note-once"
      },
      method: "POST",
      payload: { body: "Private production note" },
      url: `/admin/messages/orders/${orderId}/notes`
    });

    expect(response.statusCode).toBe(201);
    expect(repo.addNote).toHaveBeenCalledWith(
      orderId,
      expect.any(Object),
      { body: "Private production note" },
      "note-once",
    );
    await app.close();
  });

  it("accepts signed inbound events and rejects unsigned requests", async () => {
    const repo = repository();
    const { app } = await server(repo);
    const payload = {
      body: "Thanks!",
      channel: "email" as const,
      eventId: "event-1",
      from: "customer@example.test",
      providerMessageId: "provider-message-1",
      threadKey: `kapchi-order:${orderId}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: "message.received" as const
    };

    const unsigned = await app.inject({
      method: "POST",
      payload,
      url: "/messaging/webhooks/sandbox"
    });
    expect(unsigned.statusCode).toBe(401);

    const signed = await app.inject({
      headers: {
        "x-kapchi-message-signature": signMessagingWebhook(payload, "test-webhook-secret")
      },
      method: "POST",
      payload,
      url: "/messaging/webhooks/sandbox"
    });
    expect(signed.statusCode).toBe(202);
    expect(repo.receiveWebhook).toHaveBeenCalledWith(
      "sandbox",
      payload,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    await app.close();
  });

  it("lets admins discover filtered terminal notification failures without private fields", async () => {
    const repo = repository();
    const { app, notifications } = await server(repo);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/messages/transactional-notifications?state=failed&failureCode=MESSAGE_CONTACT_UNAVAILABLE"
    });

    expect(response.statusCode).toBe(200);
    expect(notifications.list).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE",
      state: "failed"
    }));
    expect(response.json().notifications[0]).toMatchObject({
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE",
      publicOrderNumber: "KAP-TEST"
    });
    expect(response.body).not.toContain("customer@example.test");
    expect(response.body).not.toContain("tracking");
    await app.close();
  });

  it("adds safe transactional status to conversation detail", async () => {
    const repo = repository();
    const { app, notifications } = await server(repo);
    const statuses = (await notifications.list()).notifications;
    notifications.listForOrder.mockResolvedValueOnce(statuses);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/messages/conversations/${orderId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transactionalNotifications[0]).toMatchObject({
      failureCode: "MESSAGE_CONTACT_UNAVAILABLE",
      publicOrderNumber: "KAP-TEST"
    });
    expect(response.body).not.toContain("customer@example.test");
    await app.close();
  });

  it("does not expose transactional notification status to customers", async () => {
    const repo = repository();
    const { app, notifications } = await server(repo);
    const response = await app.inject({
      headers: { authorization: "Bearer customer-token" },
      method: "GET",
      url: "/admin/messages/transactional-notifications"
    });

    expect(response.statusCode).toBe(403);
    expect(notifications.list).not.toHaveBeenCalled();
    await app.close();
  });
});
