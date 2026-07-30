import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn()
}));

vi.mock("../../config/index.js", () => ({
  config: {
    payments: {
      stripe: {
        apiVersion: "2026-02-25.clover",
        secretKey: "sk_test_123",
        webhookSecret: "whsec_test"
      }
    }
  }
}));

vi.mock("stripe", () => ({
  default: vi.fn(function Stripe() {
    return {
      webhooks: {
        constructEvent: mocks.constructEvent
      }
    };
  })
}));

const { default: paymentsPlugin } = await import("./plugin.js");

async function buildTestServer() {
  const app = fastify({ logger: false });
  await app.register(paymentsPlugin, { prefix: "/payments" });

  return app;
}

describe("paymentsPlugin Stripe webhooks", () => {
  beforeEach(() => {
    mocks.constructEvent.mockReset();
  });

  it("returns 400 when the Stripe signature is missing", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      payload: JSON.stringify({ id: "evt_test" }),
      url: "/payments/webhooks/stripe"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "BAD_REQUEST",
      message: "Missing Stripe signature.",
      statusCode: 400
    });
    expect(mocks.constructEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 400 for invalid Stripe webhook payloads", async () => {
    mocks.constructEvent.mockImplementation(() => {
      throw new Error("invalid signature");
    });

    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "stripe-signature": "invalid"
      },
      method: "POST",
      payload: JSON.stringify({ id: "evt_test" }),
      url: "/payments/webhooks/stripe"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe(
      "Invalid Stripe webhook signature or payload.",
    );

    await app.close();
  });

  it("acknowledges verified Stripe webhook events", async () => {
    mocks.constructEvent.mockReturnValue({
      type: "checkout.session.completed"
    });
    const payload = JSON.stringify({ id: "evt_test" });

    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid"
      },
      method: "POST",
      payload,
      url: "/payments/webhooks/stripe"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      event_type: "checkout.session.completed",
      received: true
    });
    expect(mocks.constructEvent).toHaveBeenCalledWith(
      payload,
      "valid",
      "whsec_test",
    );

    await app.close();
  });
});
