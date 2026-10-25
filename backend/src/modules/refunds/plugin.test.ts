import fastify from "fastify";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyClerkToken: vi.fn() }));
vi.mock("../auth/jwt.js", () => ({ verifyClerkToken: mocks.verifyClerkToken }));
vi.mock("../../config/index.js", () => ({
  config: {
    payments: {
      stripe: {
        apiVersion: "2026-02-25.clover",
        secretKey: "sk_test_123"
      }
    }
  }
}));

const [{ authPlugin }, { createRefundPlugin }] = await Promise.all([
  import("../auth/index.js"),
  import("./plugin.js")
]);

const operation = {
  amountCents: 2500,
  clientIdempotencyKey: "refund-key",
  createdAt: "2026-10-01T12:00:00.000Z",
  currency: "usd",
  failedAt: null,
  failureCode: null,
  id: "3de37830-b86f-43bb-a0b1-d6938b85ad59",
  manualReviewRequired: false,
  nextReconciliationAt: null,
  notificationRequested: true,
  orderId: "719ddc98-6333-4ffd-8040-ce43ac569628",
  pendingReason: null,
  providerRefundId: "re_test",
  restockRequested: false,
  status: "succeeded" as const,
  succeededAt: "2026-10-01T12:00:01.000Z"
};

function authenticated({
  permissions = [],
  roles = ["admin"]
}: {
  permissions?: string[];
  roles?: string[];
} = {}) {
  mocks.verifyClerkToken.mockResolvedValue({
    claims: {},
    permissions,
    roles,
    sessionId: "sess_admin",
    token: "verified-token",
    userId: "user_admin"
  });
}

async function build(service: Record<string, unknown>) {
  const app = fastify({ logger: false });
  await app.register(authPlugin);
  app.decorate("pg", {} as Pool);
  await app.register(
    createRefundPlugin({
      providerFactory: () => ({}) as never,
      repositoryFactory: () => ({}) as never,
      serviceFactory: () => service as never
    }),
    { prefix: "/admin" },
  );
  return app;
}

describe("refundPlugin", () => {
  beforeEach(() => mocks.verifyClerkToken.mockReset());

  it("rejects permission-only and organization-admin principals", async () => {
    authenticated({
      permissions: ["orders:refund"],
      roles: ["org:admin"]
    });
    const app = await build({});
    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: `/admin/refunds/${operation.id}`
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("creates a successful refund from a verified local actor", async () => {
    authenticated();
    const create = vi.fn(async () => ({ operation, replayed: false }));
    const resolveActor = vi.fn(async () => ({
      authSubject: "user_admin",
      userId: "02d8ff54-38c9-4420-a74c-b770916c6260"
    }));
    const app = await build({ create, resolveActor });
    const response = await app.inject({
      headers: {
        authorization: "Bearer verified-token",
        "idempotency-key": "refund-key"
      },
      method: "POST",
      payload: {
        amountCents: 2500,
        currency: "usd",
        notificationRequested: true,
        reasonCode: "requested_by_customer",
        restockRequested: false
      },
      url: `/admin/orders/${operation.orderId}/refunds`
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: operation.id, status: "succeeded" });
    expect(create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("fails closed when the verified subject has no active local user", async () => {
    authenticated();
    const app = await build({ resolveActor: vi.fn(async () => null) });
    const response = await app.inject({
      headers: {
        authorization: "Bearer verified-token",
        "idempotency-key": "refund-key"
      },
      method: "POST",
      payload: {
        amountCents: 2500,
        currency: "usd",
        notificationRequested: false,
        reasonCode: "other",
        restockRequested: false
      },
      url: `/admin/orders/${operation.orderId}/refunds`
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("REFUND_ACTOR_UNAVAILABLE");
    await app.close();
  });

  it("rejects fractional minor-unit amounts before the service", async () => {
    authenticated();
    const app = await build({ resolveActor: vi.fn() });
    const response = await app.inject({
      headers: {
        authorization: "Bearer verified-token",
        "idempotency-key": "refund-key"
      },
      method: "POST",
      payload: {
        amountCents: 12.5,
        currency: "usd",
        notificationRequested: false,
        reasonCode: "other",
        restockRequested: false
      },
      url: `/admin/orders/${operation.orderId}/refunds`
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
