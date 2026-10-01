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
  { CheckoutCatalogUnavailableError, CheckoutNeedsReviewError },
  { createPaymentsPlugin, default: paymentsPlugin }
] = await Promise.all([
  import("../auth/index.js"),
  import("./checkout-errors.js"),
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
      publicOrderNumber: "KAP-2DB9F8E1D0F0",
      url: "https://checkout.stripe.test/session"
    };
    const startCheckout = vi.fn(async () => checkoutResult);
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus: vi.fn(),
      markCatalogUnavailable: vi.fn(),
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
      payload: {
        cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
        cartRevision: 7,
        customerEmail: " Customer@Example.com ",
        preferredContactMethod: "email"
      },
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
      {
        authSubject: "user_123",
        cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
        expectedRevision: 7
      },
      {
        customerEmail: "customer@example.com",
        customerPhone: null,
        preferredContactMethod: "email"
      },
    );
    expect(mocks.stripeConstructor).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes guest phone input before starting checkout", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const checkoutResult = {
      checkoutSessionId: "cs_test_guest",
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      paymentStatus: "checkout_started" as const,
      publicOrderNumber: "KAP-2DB9F8E1D0F0",
      url: "https://checkout.stripe.test/session"
    };
    const startCheckout = vi.fn(async () => checkoutResult);
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus: vi.fn(),
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [{ id: cartId }] }))
    } as unknown as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        checkoutServiceFactory: () => ({ startCheckout }),
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      cookies: { session_id: sessionId },
      method: "POST",
      payload: {
        cartId,
        cartRevision: 2,
        customerEmail: "Guest@Example.com",
        customerPhone: "+1 (555) 010-1010",
        preferredContactMethod: "phone"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(201);
    expect(startCheckout).toHaveBeenCalledWith(
      { cartId, expectedRevision: 2, sessionId },
      {
        customerEmail: "guest@example.com",
        customerPhone: "+15550101010",
        preferredContactMethod: "phone"
      },
    );
    await app.close();
  });

  it("rejects a guest checkout for a cart that does not match the session", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const ownedCartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const startCheckout = vi.fn();
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [{ id: ownedCartId }] }))
    } as unknown as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => ({}) as never,
        checkoutServiceFactory: () => ({ startCheckout }),
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      cookies: { session_id: sessionId },
      method: "POST",
      payload: {
        cartId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
        cartRevision: 2,
        customerEmail: "guest@example.com",
        customerPhone: "+15550101010",
        preferredContactMethod: "phone"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "CART_NOT_FOUND" });
    expect(startCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns safe item-level cart review issues", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const issues = [{
      cartItemId: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
      message: "The cart price changed and must be reviewed.",
      status: "needs_reprice" as const
    }];
    const startCheckout = vi.fn(async () => {
      throw new CheckoutNeedsReviewError(
        "The cart price changed and must be reviewed.",
        issues,
      );
    });
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus: vi.fn(),
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", {} as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        checkoutServiceFactory: () => ({ startCheckout }),
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "email"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "CART_NEEDS_REVIEW",
      issues,
      message: "The cart price changed and must be reviewed.",
      statusCode: 409
    });
    expect(JSON.stringify(response.json())).not.toContain("stripePriceId");
    await app.close();
  });

  it("returns a safe non-retryable catalog-unavailable response", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const startCheckout = vi.fn(async () => {
      throw new CheckoutCatalogUnavailableError();
    });
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus: vi.fn(),
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", {} as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        checkoutServiceFactory: () => ({ startCheckout }),
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "email"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "CHECKOUT_CATALOG_UNAVAILABLE",
      message:
        "Checkout is unavailable for one or more items. Please contact Kapchi support.",
      statusCode: 503
    });
    const serializedResponse = JSON.stringify(response.json());
    expect(serializedResponse).not.toContain("resource_missing");
    expect(serializedResponse).not.toContain("stripe");
    expect(serializedResponse).not.toContain("price_");
    await app.close();
  });

  it("returns the owned session token when an existing checkout completed", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const recovery = {
      checkoutSessionId: "cs_test_complete",
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      publicOrderNumber: "KAP-2DB9F8E1D0F0"
    };
    const startCheckout = vi.fn(async () => {
      throw new (await import("./checkout-errors.js")).CheckoutAlreadyCompleteError(
        recovery,
      );
    });
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus: vi.fn(),
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", {} as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        checkoutServiceFactory: () => ({ startCheckout }),
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "email"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      ...recovery,
      error: "CHECKOUT_ALREADY_COMPLETE"
    });
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

  it("requires both contact values for guests", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "email"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    await app.close();
  });

  it("requires phone for an authenticated phone preference", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const app = await buildTestServer();
    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "POST",
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "phone"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("phone is required");
    await app.close();
  });

  it("rejects client-controlled order identity and redirect fields", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        cancelUrl: "https://attacker.test/cancel",
        customerEmail: "customer@example.com",
        customerPhone: "+15550101010",
        orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
        preferredContactMethod: "email"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION_ERROR");

    await app.close();
  });

  it("requires cart id and revision to be supplied together", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
        customerEmail: "customer@example.com",
        customerPhone: "+15550101010",
        preferredContactMethod: "email"
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
      payload: {
        customerEmail: "customer@example.com",
        preferredContactMethod: "email"
      },
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
      payload: {
        customerEmail: "customer@example.com",
        customerPhone: "+1 (555) 010-1010",
        preferredContactMethod: "phone"
      },
      url: "/payments/checkout-sessions"
    });

    expect(response.statusCode).toBe(404);
    expect(redisGet).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(String(poolQuery.mock.calls[0][0])).toContain("guest_token_hash = $1");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("rollback");

    await app.close();
  });

  it("returns only payment state for an authenticated checkout owner", async () => {
    mocks.verifyClerkToken.mockResolvedValue({
      claims: {},
      permissions: [],
      roles: [],
      sessionId: "sess_authenticated",
      token: "verified-token",
      userId: "user_123"
    });
    const status = {
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      paymentStatus: "paid",
      publicOrderNumber: "KAP-2DB9F8E1D0F0"
    };
    const getCheckoutStatus = vi.fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(null);
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus,
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", {} as Pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const owned = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/payments/checkout-sessions/cs_test_owned/status"
    });
    const denied = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/payments/checkout-sessions/cs_test_other/status"
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toEqual(status);
    expect(Object.keys(owned.json()).sort()).toEqual([
      "orderId",
      "paymentStatus",
      "publicOrderNumber"
    ]);
    expect(getCheckoutStatus).toHaveBeenNthCalledWith(
      1,
      { authSubject: "user_123" },
      "cs_test_owned",
    );
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error).toBe("CHECKOUT_NOT_FOUND");
    await app.close();
  });

  it("authorizes guest status through the durable cookie cart owner", async () => {
    const sessionId = "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789";
    const cartId = "53fcaccc-1baa-4072-abbb-c51d20f3588b";
    const getCheckoutStatus = vi.fn(async () => ({
      orderId: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8",
      paymentStatus: "checkout_started",
      publicOrderNumber: "KAP-2DB9F8E1D0F0"
    }));
    const repository = {
      finalizeCheckout: vi.fn(),
      getCheckoutStatus,
      markCatalogUnavailable: vi.fn(),
      markProviderFailure: vi.fn(),
      prepareCheckout: vi.fn(),
      retireTerminalCheckout: vi.fn()
    };
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [{ id: cartId }] }))
    } as unknown as Pool;
    const app = fastify({ logger: false });
    await app.register(cookie);
    await app.register(authPlugin);
    app.decorate("pg", pool);
    await app.register(
      createPaymentsPlugin({
        checkoutRepositoryFactory: () => repository,
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      cookies: { session_id: sessionId },
      method: "GET",
      url: "/payments/checkout-sessions/cs_test_guest/status"
    });

    expect(response.statusCode).toBe(200);
    expect(getCheckoutStatus).toHaveBeenCalledWith(
      { cartId, sessionId },
      "cs_test_guest",
    );
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
      id: "evt_test",
      type: "customer.created"
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
      event_type: "customer.created",
      received: true
    });
    expect(mocks.constructEvent).toHaveBeenCalledWith(
      payload,
      "valid",
      "whsec_test",
    );

    await app.close();
  });

  it("does not mark an unpaid completed Checkout Session as paid", async () => {
    mocks.constructEvent.mockReturnValue({
      data: {
        object: {
          id: "cs_test_pending",
          metadata: {
            order_id: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8"
          },
          payment_status: "unpaid"
        }
      },
      id: "evt_checkout_pending",
      type: "checkout.session.completed"
    });
    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid"
      },
      method: "POST",
      payload: JSON.stringify({ id: "evt_checkout_pending" }),
      url: "/payments/webhooks/stripe"
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("processes duplicate and out-of-order successful events once", async () => {
    const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
    let paid = false;
    let paidEventCount = 0;
    const receivedWebhookIds = new Set<string>();
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (["begin", "commit", "rollback"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("insert into stripe_webhook_events")) {
        const eventId = String(values?.[0]);
        if (receivedWebhookIds.has(eventId)) return { rows: [] };
        receivedWebhookIds.add(eventId);
        return { rows: [{ stripe_event_id: eventId }] };
      }
      if (sql.includes("from orders")) {
        return {
          rows: [{
            fulfillment_status: paid ? "queued" : "not_started",
            id: orderId,
            paid_at: paid ? new Date("2026-08-01T12:00:00.000Z") : null,
            payment_status: paid ? "paid" : "checkout_started",
            status: paid ? "paid" : "pending_payment",
            stripe_checkout_session_id: "cs_test_paid",
            stripe_payment_intent_id: paid ? "pi_test_paid" : null
          }]
        };
      }
      if (sql.includes("update orders")) {
        paid = true;
      }
      if (sql.includes("insert into order_events")) {
        paidEventCount += 1;
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query
    } as unknown as Pool;
    mocks.constructEvent
      .mockReturnValueOnce({
        data: {
          object: { id: "pi_test_paid", metadata: { order_id: orderId } }
        },
        id: "evt_pi_paid",
        type: "payment_intent.succeeded"
      })
      .mockReturnValueOnce({
        data: {
          object: {
            id: "cs_test_paid",
            metadata: { order_id: orderId },
            payment_intent: "pi_test_paid",
            payment_status: "paid"
          }
        },
        id: "evt_checkout_paid",
        type: "checkout.session.completed"
      })
      .mockReturnValueOnce({
        data: {
          object: {
            id: "cs_test_paid",
            metadata: { order_id: orderId },
            payment_intent: "pi_test_paid",
            payment_status: "paid"
          }
        },
        id: "evt_checkout_paid",
        type: "checkout.session.completed"
      });
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", pool);
    await app.register(paymentsPlugin, { prefix: "/payments" });

    for (const eventId of ["evt_pi_paid", "evt_checkout_paid", "evt_checkout_paid"]) {
      const response = await app.inject({
        headers: {
          "content-type": "application/json",
          "stripe-signature": "valid"
        },
        method: "POST",
        payload: JSON.stringify({ id: eventId }),
        url: "/payments/webhooks/stripe"
      });
      expect(response.statusCode).toBe(200);
    }

    expect(paidEventCount).toBe(1);
    expect(release).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns non-2xx when successful webhook persistence fails", async () => {
    const databaseError = Object.assign(new Error("private database host"), {
      code: "ECONNRESET"
    });
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") {
        return { rows: [] };
      }
      throw databaseError;
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => {
        throw databaseError;
      })
    } as unknown as Pool;
    const observer = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    mocks.constructEvent.mockReturnValue({
      data: {
        object: {
          id: "pi_test_failure",
          metadata: {
            order_id: "2db9f8e1-d0f0-4b39-b521-1ab59db038c8"
          }
        }
      },
      id: "evt_persistence_failure",
      type: "payment_intent.succeeded"
    });
    const app = fastify({ logger: false });
    await app.register(authPlugin);
    app.decorate("pg", pool);
    await app.register(
      createPaymentsPlugin({
        observerFactory: () => observer,
        stripeClientFactory: () => ({
          checkout: { sessions: {} },
          webhooks: { constructEvent: mocks.constructEvent }
        }) as never
      }),
      { prefix: "/payments" },
    );

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid"
      },
      method: "POST",
      payload: JSON.stringify({ id: "evt_persistence_failure" }),
      url: "/payments/webhooks/stripe"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("WEBHOOK_PROCESSING_ERROR");
    expect(release).not.toHaveBeenCalled();
    expect(observer.error).toHaveBeenCalledWith("stripe.webhook.failed", {
      errorCode: "ECONNRESET",
      errorType: "Error",
      webhookEventId: "evt_persistence_failure",
      webhookEventType: "payment_intent.succeeded"
    });
    expect(JSON.stringify(observer.error.mock.calls)).not.toContain("private database");
    await app.close();
  });
});
