import cookie from "@fastify/cookie";
import fastify from "fastify";
import type { Pool, PoolClient } from "pg";
import type { RedisClientType } from "redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  stripeConstructor: vi.fn(),
  verifyClerkToken: vi.fn()
}));

vi.mock("../auth/jwt.js", () => ({
  verifyClerkToken: mocks.verifyClerkToken
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
    mocks.stripeConstructor();
    return {
      checkout: { sessions: {} },
      webhooks: {
        constructEvent: mocks.constructEvent
      }
    };
  })
}));

const [
  { authPlugin },
  { createPaymentsPlugin, default: paymentsPlugin }
] = await Promise.all([
  import("../auth/index.js"),
  import("./plugin.js")
]);
const stripeClientsConstructedDuringImport = mocks.stripeConstructor.mock.calls.length;

async function buildTestServer() {
  const app = fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(paymentsPlugin, { prefix: "/payments" });

  return app;
}

describe("paymentsPlugin Stripe webhooks", () => {
  beforeEach(() => {
    mocks.constructEvent.mockReset();
    mocks.stripeConstructor.mockClear();
    mocks.verifyClerkToken.mockReset();
  });

  it("defers Stripe construction until the plugin is registered", async () => {
    expect(stripeClientsConstructedDuringImport).toBe(0);

    const app = await buildTestServer();

    expect(mocks.stripeConstructor).toHaveBeenCalledOnce();
    await app.close();
  });

  it("composes injected payment dependencies at the request boundary", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const checkoutResult = {
      checkoutSessionId: "cs_test_injected",
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      paymentStatus: "checkout_started" as const,
      url: "https://checkout.stripe.test/session"
    };
    const startCheckout = vi.fn(async () => checkoutResult);
    const repository = {
      finalizeCheckout: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const provider = {
      createSession: vi.fn(),
      retrieveSession: vi.fn()
    };
    const observer = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    };
    const clock = { now: () => new Date("2026-08-01T12:00:00.000Z") };
    const checkoutServiceFactory = vi.fn(() => ({ startCheckout }));
    const stripe = {
      checkout: { sessions: {} },
      webhooks: { constructEvent: mocks.constructEvent }
    };
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", {} as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutProviderFactory: () => provider,
        checkoutRepositoryFactory: () => repository,
        checkoutServiceFactory,
        clock,
        observerFactory: () => observer,
        paymentConfig: {
          checkout: {
            cancelUrl: "https://kapchi.test/cart",
            successUrl: "https://kapchi.test/orders"
          },
          stripe: { webhookSecret: "whsec_injected" }
        },
        stripeClientFactory: () => stripe as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: { customerEmail: "customer@example.com" },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(checkoutResult);
    expect(checkoutServiceFactory).toHaveBeenCalledWith({
      clock,
      observer,
      provider,
      redirects: {
        cancelUrl: "https://kapchi.test/cart",
        successUrl: "https://kapchi.test/orders"
      },
      repository
    });
    expect(startCheckout).toHaveBeenCalledWith(
      { authSubject: "user_123" },
      { customerEmail: "customer@example.com", customerPhone: null },
    );
    expect(mocks.stripeConstructor).not.toHaveBeenCalled();
    await app.close();
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

  it("resolves authenticated checkout from PostgreSQL without guest or Redis access", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const poolQuery = vi.fn();
    const clientQuery = vi.fn(async (sql: string) => {
      if (["begin", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("from carts c")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const client = {
      query: clientQuery,
      release: vi.fn()
    } as unknown as PoolClient;
    const redisGet = vi.fn();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate(
      "pg",
      { connect: vi.fn(async () => client), query: poolQuery } as unknown as Pool,
    );
    app.decorate("redis", { get: redisGet } as unknown as RedisClientType);
    await app.register(paymentsPlugin, { prefix: "/payments" });

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: { customerEmail: "customer@example.com" },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("CART_NOT_FOUND");
    expect(poolQuery).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(String(clientQuery.mock.calls[1][0])).toContain("left join users");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("rollback");

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
    await app.register(authPlugin);
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
