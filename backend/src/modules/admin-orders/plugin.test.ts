import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOrderError } from "./errors.js";
import type { AdminOrderReader } from "./repository.js";
import type {
  AdminOrderDetail,
  AdminOrderSearchPage,
  AdminOrderTimelinePage
} from "./types.js";

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
          userId: "user_123"
        }
      : null;
  },
  requireRole: (role: string) => async (
    request: { auth: { roles: string[] } | null },
    reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  ) => {
    if (!request.auth) {
      reply.code(401).send({ error: "UNAUTHORIZED", message: "Authentication is required.", statusCode: 401 });
      return;
    }
    if (!request.auth.roles.includes(role)) {
      reply.code(403).send({ error: "FORBIDDEN", message: `Missing required role: ${role}`, statusCode: 403 });
    }
  }
}));

const { createAdminOrderPlugin } = await import("./plugin.js");

const order = {
  createdAt: "2026-10-25T12:00:00.000Z",
  customer: { email: "customer@example.test", name: "Customer", phone: null, preferredContactMethod: "email" as const },
  discount: { amountMinor: 0, currency: "usd" },
  fulfillmentStatus: "queued" as const,
  id: "11111111-1111-4111-8111-111111111111",
  itemCount: 1,
  payment: {
    captured: { amountMinor: 5000, currency: "usd" },
    currencyIntegrity: "consistent" as const,
    pendingRefunds: { amountMinor: 0, currency: "usd" },
    refundableBalance: { amountMinor: 5000, currency: "usd" },
    succeededRefunds: { amountMinor: 0, currency: "usd" }
  },
  paymentStatus: "paid" as const,
  publicOrderNumber: "KAP-1001",
  status: "paid" as const,
  total: { amountMinor: 5000, currency: "usd" },
  totalQuantity: 1,
  updatedAt: "2026-10-25T12:00:00.000Z"
};

const page: AdminOrderSearchPage = { nextCursor: null, orders: [order] };
const detail: AdminOrderDetail = {
  ...order,
  cancelledAt: null,
  completedAt: null,
  contactSnapshot: order.customer,
  fulfillments: [],
  items: [],
  paidAt: "2026-10-25T12:00:00.000Z",
  shipments: [],
  shippedAt: null,
  shipping: { address: null, name: "Customer" }
};
const timeline: AdminOrderTimelinePage = { entries: [], nextCursor: null };

describe("admin order plugin", () => {
  const repository: AdminOrderReader = {
    detail: vi.fn(async () => detail),
    search: vi.fn(async () => page),
    timeline: vi.fn(async () => timeline)
  };

  beforeEach(() => {
    vi.mocked(repository.detail).mockClear();
    vi.mocked(repository.search).mockClear();
    vi.mocked(repository.timeline).mockClear();
  });

  async function buildServer(reader: AdminOrderReader = repository) {
    const app = fastify({ logger: false });
    await app.register(createAdminOrderPlugin({ repository: reader }), {
      prefix: "/admin/orders"
    });
    return app;
  }

  it("applies safe ongoing search defaults for an authorized admin", async () => {
    const app = await buildServer();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/orders"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page);
    expect(repository.search).toHaveBeenCalledWith({
      discountedOnly: false,
      lifecycle: "ongoing",
      limit: 25,
      paidOnly: false,
      refundedOnly: false,
      sort: "created_desc"
    });
    await app.close();
  });

  it("passes independent filters without logging or trusting client actor data", async () => {
    const app = await buildServer();
    const params = new URLSearchParams({
      createdFrom: "2026-10-01",
      createdTo: "2026-10-25",
      discountedOnly: "true",
      fulfillmentStatus: "ready_to_ship",
      lifecycle: "all",
      paidOnly: "true",
      refundedOnly: "true",
      search: "Name+Tag@example.test",
      sort: "created_asc"
    });
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders?${params}`
    });

    expect(response.statusCode).toBe(200);
    expect(repository.search).toHaveBeenCalledWith(expect.objectContaining({
      createdFrom: "2026-10-01",
      createdTo: "2026-10-25",
      discountedOnly: true,
      fulfillmentStatus: "ready_to_ship",
      lifecycle: "all",
      paidOnly: true,
      refundedOnly: true,
      search: "Name+Tag@example.test",
      sort: "created_asc"
    }));
    await app.close();
  });

  it.each([
    { authorization: undefined, statusCode: 401 },
    { authorization: "Bearer customer-token", statusCode: 403 }
  ])("denies non-admin order access", async ({ authorization, statusCode }) => {
    const app = await buildServer();
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "GET",
      url: "/admin/orders"
    });

    expect(response.statusCode).toBe(statusCode);
    expect(repository.search).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    "/admin/orders?createdFrom=2026-02-30",
    "/admin/orders?createdFrom=2026-10-25&createdTo=2026-10-01",
    "/admin/orders?createdFrom=2025-01-01&createdTo=2026-01-02",
    "/admin/orders?unknown=true"
  ])("rejects invalid search contracts", async (url) => {
    const app = await buildServer();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_ERROR");
    expect(repository.search).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns detail and timeline through separate paginated contracts", async () => {
    const app = await buildServer();
    const headers = { authorization: "Bearer admin-token" };
    const detailResponse = await app.inject({
      headers,
      method: "GET",
      url: `/admin/orders/${order.id}`
    });
    const timelineResponse = await app.inject({
      headers,
      method: "GET",
      url: `/admin/orders/${order.id}/timeline?limit=10`
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toEqual(detail);
    expect(timelineResponse.statusCode).toBe(200);
    expect(repository.timeline).toHaveBeenCalledWith(order.id, { limit: 10 });
    await app.close();
  });

  it("returns consistent not-found and unavailable states", async () => {
    const missing = {
      ...repository,
      detail: vi.fn(async () => {
        throw new AdminOrderError("ORDER_NOT_FOUND", "Order not found.", 404);
      })
    };
    const unavailable = {
      ...repository,
      search: vi.fn(async () => {
        throw Object.assign(new Error("private connection detail"), { code: "ECONNREFUSED" });
      })
    };
    const missingApp = await buildServer(missing);
    const missingResponse = await missingApp.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${order.id}`
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      error: "ORDER_NOT_FOUND",
      message: "Order not found.",
      statusCode: 404
    });
    await missingApp.close();

    const unavailableApp = await buildServer(unavailable);
    const unavailableResponse = await unavailableApp.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/orders"
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toEqual({
      error: "ADMIN_ORDERS_UNAVAILABLE",
      message: "Admin order data is temporarily unavailable.",
      statusCode: 503
    });
    expect(unavailableResponse.headers["retry-after"]).toBe("30");
    await unavailableApp.close();
  });
});
