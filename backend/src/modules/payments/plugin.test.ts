import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import paymentsPlugin from "./plugin.js";

const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
const successUrl = "https://kapchi.example/success";
const cancelUrl = "https://kapchi.example/cancel";

const mocks = vi.hoisted(() => ({
  checkoutSessionsCreate: vi.fn(),
  connect: vi.fn(),
  constructEvent: vi.fn(),
  query: vi.fn(),
  release: vi.fn()
}));

vi.mock("../../config/index.js", () => ({
  config: {
    payments: {
      stripe: {
        webhookSecret: "whsec_test"
      }
    }
  }
}));

vi.mock("../../database/index.js", () => ({
  getDatabasePool: () => ({
    connect: mocks.connect
  })
}));

vi.mock("./stripe.js", () => ({
  getStripeClient: () => ({
    checkout: {
      sessions: {
        create: mocks.checkoutSessionsCreate
      }
    },
    webhooks: {
      constructEvent: mocks.constructEvent
    }
  })
}));

const payableOrder = {
  id: orderId,
  status: "pending_payment",
  payment_status: "unpaid",
  customer_email: "customer@example.com",
  subtotal_cents: 12900,
  shipping_cents: 0,
  tax_cents: 0,
  discount_cents: 0,
  total_cents: 12900,
  currency: "usd"
};

const orderItem = {
  id: "5863e978-6764-41f4-96bd-ea2337d11204",
  order_id: orderId,
  quantity: 1,
  unit_amount_cents: 12900,
  total_amount_cents: 12900,
  currency: "usd",
  listing_snapshot: {
    title: "Custom Graduation Stole"
  }
};

function createQueryMock({
  items = [orderItem],
  order = payableOrder
}: {
  items?: typeof orderItem[];
  order?: typeof payableOrder | null;
} = {}) {
  return vi.fn((sql: string) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return Promise.resolve({ rows: [] });
    }

    if (sql.includes("from orders")) {
      return Promise.resolve({ rows: order ? [order] : [] });
    }

    if (sql.includes("from order_items")) {
      return Promise.resolve({ rows: items });
    }

    if (sql.includes("update orders")) {
      return Promise.resolve({ rows: [] });
    }

    throw new Error(`Unexpected query: ${sql}`);
  });
}

async function buildTestServer() {
  const app = fastify({ logger: false });
  await app.register(paymentsPlugin, { prefix: "/payments" });

  return app;
}

function checkoutPayload(overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...overrides
  };
}

describe("paymentsPlugin checkout sessions", () => {
  beforeEach(() => {
    mocks.checkoutSessionsCreate.mockReset();
    mocks.connect.mockReset();
    mocks.constructEvent.mockReset();
    mocks.query = createQueryMock();
    mocks.release.mockReset();
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release
    });
    mocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      customer: "cus_test_123",
      expires_at: 1783296000
    });
  });

  it("returns 400 for an invalid body", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: {
        order_id: "not-a-uuid",
        success_url: successUrl,
        cancel_url: cancelUrl
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_ERROR");
    expect(mocks.connect).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 404 when the order does not exist", async () => {
    mocks.query = createQueryMock({ order: null });
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("ORDER_NOT_FOUND");
    expect(mocks.checkoutSessionsCreate).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("rollback");

    await app.close();
  });

  it("returns 409 for a bad order state", async () => {
    mocks.query = createQueryMock({
      order: {
        ...payableOrder,
        status: "paid"
      }
    });
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("ORDER_NOT_PAYABLE");
    expect(mocks.checkoutSessionsCreate).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 409 when the order has no items", async () => {
    mocks.query = createQueryMock({ items: [] });
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe("Order must contain at least one item.");
    expect(mocks.checkoutSessionsCreate).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 409 when the order total is zero", async () => {
    mocks.query = createQueryMock({
      order: {
        ...payableOrder,
        subtotal_cents: 0,
        total_cents: 0
      },
      items: [
        {
          ...orderItem,
          unit_amount_cents: 0,
          total_amount_cents: 0
        }
      ]
    });
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe("Order total must be greater than zero.");
    expect(mocks.checkoutSessionsCreate).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 502 when Stripe checkout session creation fails", async () => {
    mocks.checkoutSessionsCreate.mockRejectedValue(new Error("stripe unavailable"));

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("CHECKOUT_PROVIDER_ERROR");
    expect(mocks.query).toHaveBeenCalledWith("rollback");

    await app.close();
  });

  it("creates a checkout session with metadata and persists checkout state", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/payments/checkout-sessions",
      payload: checkoutPayload()
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      checkout_session_id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
      order_id: orderId,
      payment_status: "checkout_started"
    });

    expect(mocks.checkoutSessionsCreate).toHaveBeenCalledWith({
      cancel_url: cancelUrl,
      client_reference_id: orderId,
      customer_email: "customer@example.com",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Custom Graduation Stole"
            },
            unit_amount: 12900
          },
          quantity: 1
        }
      ],
      metadata: {
        order_id: orderId
      },
      mode: "payment",
      payment_intent_data: {
        metadata: {
          order_id: orderId
        }
      },
      success_url: successUrl
    });

    const updateCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("update orders"),
    );
    expect(updateCall?.[1]).toEqual([
      orderId,
      "cs_test_123",
      "cus_test_123",
      new Date("2026-07-06T00:00:00.000Z")
    ]);
    expect(mocks.query).toHaveBeenCalledWith("commit");

    await app.close();
  });
});
