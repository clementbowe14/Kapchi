import cookie from "@fastify/cookie";
import fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import type { RedisClientType } from "redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn()
}));

vi.mock("../../config/index.js", () => ({
  config: {
    payments: {
      checkout: {
        cancelUrl: "https://kapchi.test/cart",
        successUrl: "https://kapchi.test/orders"
      },
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

  it("rejects client-controlled order identity and redirect fields", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        cancelUrl: "https://attacker.test/cancel",
        customerEmail: "customer@example.com",
        orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("derives checkout ownership from PostgreSQL without reading Redis", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const poolQuery = vi.fn(async (_sql: string, _values: unknown[] = []) => ({
      rows: [{ id: "53fcaccc-1baa-4072-abbb-c51d20f3588b" }]
    }));
    const clientQuery = vi.fn(async (sql: string) => {
      if (["begin", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const client = {
      query: clientQuery,
      release: vi.fn()
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query: poolQuery
    } as unknown as Pool;
    const redisGet = vi.fn();
    const redis = { get: redisGet } as unknown as RedisClientType;
    const app = fastify({ logger: false });
    await app.register(cookie);
    app.decorate("pg", pool);
    app.decorate("redis", redis);
    await app.register(paymentsPlugin, { prefix: "/payments" });

    const response = await app.inject({
      cookies: { session_id: sessionId },
      method: "POST",
      payload: { customerEmail: "customer@example.com" },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(404);
    expect(redisGet).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(String(poolQuery.mock.calls[0][0])).toContain("guest_token_hash = $1");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("rollback");

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
