import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ordersPlugin from "./plugin.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../../database/index.js", () => ({
  getDatabasePool: () => ({
    query: mocks.query
  })
}));

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: {
    auth: unknown;
    headers: { authorization?: string };
  }) => {
    request.auth =
      request.headers.authorization === "Bearer customer-token"
        ? {
            claims: {},
            permissions: [],
            roles: [],
            sessionId: null,
            token: "customer-token",
            userId: "user_123"
          }
        : null;
  },
  requireAuth: async (
    request: { auth: unknown },
    reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  ) => {
    if (!request.auth) {
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Authentication is required.",
        statusCode: 401
      });
    }
  }
}));

const orderRow = {
  id: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
  public_order_number: "KAP-1001",
  status: "confirmed",
  payment_status: "paid",
  fulfillment_status: "in_progress",
  customer_email: "Customer@Example.com",
  customer_phone: "+1 (555) 010-1010",
  total_cents: 12900,
  currency: "usd",
  created_at: new Date("2026-06-01T12:00:00.000Z"),
  paid_at: new Date("2026-06-01T12:05:00.000Z"),
  production_notes: "do not expose"
};

const itemRow = {
  asset_byte_size: null,
  asset_content_type: null,
  asset_id: null,
  asset_provider: null,
  asset_visibility: null,
  id: "5863e978-6764-41f4-96bd-ea2337d11204",
  order_id: orderRow.id,
  quantity: 1,
  unit_amount_cents: 12900,
  total_amount_cents: 12900,
  currency: "usd",
  listing_snapshot: { title: "Custom Jacket" },
  fabric_snapshot: { name: "Linen" },
  customization_snapshot: { size: "M", monogram: "CB" },
  production_notes: "do not expose"
};

const itemRowWithAsset = {
  ...itemRow,
  asset_byte_size: 2048,
  asset_content_type: "image/png",
  asset_id: "3a318519-8cf8-4392-af89-47a191242b44",
  asset_provider: "vercel_blob",
  asset_visibility: "private"
};

async function buildTestServer() {
  const app = fastify({ logger: false });
  await app.register(ordersPlugin);

  return app;
}

describe("ordersPlugin", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("looks up an order when the submitted email matches", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRow] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: {
        orderId: "KAP-1001",
        email: " customer@example.com "
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: orderRow.id,
      publicOrderNumber: "KAP-1001",
      status: "confirmed",
      paymentStatus: "paid",
      fulfillmentStatus: "in_progress",
      customerEmail: "Customer@Example.com",
      customerPhone: "+1 (555) 010-1010",
      totalCents: 12900,
      currency: "usd",
      createdAt: "2026-06-01T12:00:00.000Z",
      paidAt: "2026-06-01T12:05:00.000Z",
      tracking: null,
      items: [
        {
          id: itemRow.id,
          quantity: 1,
          unitAmountCents: 12900,
          totalAmountCents: 12900,
          currency: "usd",
          listingSnapshot: { title: "Custom Jacket" },
          fabricSnapshot: { name: "Linen" },
          customizationSummary: { size: "M", monogram: "CB" }
        }
      ]
    });
    expect(response.body).not.toContain("production_notes");

    await app.close();
  });

  it("returns safe asset metadata for customization images without exposing private URLs", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithAsset] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: {
        orderId: "KAP-1001",
        email: "customer@example.com"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].customizationAsset).toEqual({
      byteSize: 2048,
      contentType: "image/png",
      id: "3a318519-8cf8-4392-af89-47a191242b44",
      provider: "vercel_blob",
      visibility: "private"
    });
    expect(response.body).not.toContain("blob.vercel-storage.com");

    await app.close();
  });

  it("returns a generic 404 when the contact detail does not match", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [orderRow] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: {
        orderId: "KAP-1001",
        phone: "5559999999"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "ORDER_NOT_FOUND",
      message: "Order not found.",
      statusCode: 404
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns authenticated user's order history", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRow] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/orders/me",
      headers: {
        authorization: "Bearer customer-token"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().orders).toHaveLength(1);
    expect(response.json().orders[0].publicOrderNumber).toBe("KAP-1001");
    expect(response.body).not.toContain("production_notes");
    expect(response.body).not.toContain("adminNotes");
    expect(mocks.query.mock.calls[0][1]).toEqual(["user_123"]);

    await app.close();
  });

  it("requires auth for order history", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "GET",
      url: "/orders/me"
    });

    expect(response.statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();

    await app.close();
  });
});
