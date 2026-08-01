import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { CheckoutRepository } from "./checkout-repository.js";

const envDefaults: Record<string, string> = {
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_JWT_ISSUER: "https://clerk.test",
  CLERK_PUBLISHABLE_KEY: "test-publishable-key",
  CLERK_SECRET_KEY: "test-secret-key",
  CLERK_WEBHOOK_SECRET: "test-webhook-secret",
  DATABASE_MAX_APP_INSTANCES: "3",
  DATABASE_MAX_CONNECTIONS: "20",
  DATABASE_POOL_MAX: "5",
  DATABASE_RESERVED_CONNECTIONS: "5",
  DATABASE_SSL_MODE: "disable",
  DATABASE_STATEMENT_TIMEOUT_MS: "15000",
  DATABASE_URL: "postgres://user:pass@localhost:5432/kapchi_test",
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  STRIPE_CHECKOUT_CANCEL_URL: "https://kapchi.test/cart",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://kapchi.test/orders",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const { CheckoutService } = await import("./checkout-service.js");

const orderId = "2db9f8e1-d0f0-4b39-b521-1ab59db038c8";
const replacementOrderId = "7ad85754-c339-4214-af6e-519eabc38501";
const context = {
  cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  sessionId: "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789"
};
const contact = {
  customerEmail: "customer@example.com",
  customerPhone: null
};

function createRepository(existingStripeSessionId: string | null = null) {
  return {
    finalizeCheckout: vi.fn(),
    markProviderFailure: vi.fn(),
    retireTerminalCheckout: vi.fn(),
    prepareCheckout: vi.fn(async () => ({
      customerEmail: contact.customerEmail,
      existingStripeSessionId,
      lines: [
        {
          currency: "usd",
          orderItemId: "5863e978-6764-41f4-96bd-ea2337d11204",
          quantity: 2,
          stripePriceId: "price_test_stole"
        }
      ],
      orderId
    }))
  };
}

function stripeSession(overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id: "cs_test_123",
    customer: "cus_test_123",
    expires_at: Math.floor(
      new Date("2026-08-01T13:00:00.000Z").getTime() / 1000,
    ),
    payment_status: "unpaid",
    status: "open",
    url: "https://checkout.stripe.com/c/pay/cs_test_123",
    ...overrides
  } as Stripe.Checkout.Session;
}

describe("CheckoutService", () => {
  const create = vi.fn();
  const retrieve = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-01T12:00:00.000Z");
    create.mockReset();
    retrieve.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses durable order identity for Stripe idempotency and finalization", async () => {
    const repository = createRepository();
    create.mockResolvedValue(stripeSession());
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    const result = await service.startCheckout(context, contact);

    expect(result).toEqual({
      checkoutSessionId: "cs_test_123",
      orderId,
      paymentStatus: "checkout_started",
      url: "https://checkout.stripe.com/c/pay/cs_test_123"
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cancel_url: "https://kapchi.test/cart",
        customer_email: "customer@example.com",
        line_items: [{ price: "price_test_stole", quantity: 2 }],
        metadata: { order_id: orderId },
        success_url: "https://kapchi.test/orders"
      }),
      { idempotencyKey: `cart-checkout:${orderId}` },
    );
    expect(repository.finalizeCheckout).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({
        customerId: "cus_test_123",
        sessionId: "cs_test_123"
      }),
    );
  });

  it("retrieves an existing provider session instead of creating another", async () => {
    const repository = createRepository("cs_test_123");
    retrieve.mockResolvedValue(stripeSession());
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await service.startCheckout(context, contact);

    expect(retrieve).toHaveBeenCalledWith("cs_test_123");
    expect(create).not.toHaveBeenCalled();
    expect(repository.retireTerminalCheckout).not.toHaveBeenCalled();
  });

  it("retires an expired session and creates a fresh durable attempt", async () => {
    const repository = createRepository("cs_test_expired");
    repository.prepareCheckout
      .mockResolvedValueOnce({
        customerEmail: contact.customerEmail,
        existingStripeSessionId: "cs_test_expired",
        lines: [
          {
            currency: "usd",
            orderItemId: "5863e978-6764-41f4-96bd-ea2337d11204",
            quantity: 2,
            stripePriceId: "price_test_stole"
          }
        ],
        orderId
      })
      .mockResolvedValueOnce({
        customerEmail: contact.customerEmail,
        existingStripeSessionId: null,
        lines: [
          {
            currency: "usd",
            orderItemId: "a427a61f-868a-4fa8-91f7-e7d312601b41",
            quantity: 2,
            stripePriceId: "price_test_stole"
          }
        ],
        orderId: replacementOrderId
      });
    retrieve.mockResolvedValue(
      stripeSession({
        expires_at: Math.floor(
          new Date("2026-08-01T11:00:00.000Z").getTime() / 1000,
        ),
        id: "cs_test_expired",
        status: "expired",
        url: null
      }),
    );
    create.mockResolvedValue(
      stripeSession({ id: "cs_test_replacement" }),
    );
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    const result = await service.startCheckout(context, contact);

    expect(repository.retireTerminalCheckout).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ sessionId: "cs_test_expired" }),
      "provider_session_expired",
    );
    expect(create.mock.calls[0][1]).toEqual({
      idempotencyKey: `cart-checkout:${replacementOrderId}`
    });
    expect(result.orderId).toBe(replacementOrderId);
    expect(repository.finalizeCheckout).toHaveBeenCalledWith(
      replacementOrderId,
      expect.objectContaining({ sessionId: "cs_test_replacement" }),
    );
  });

  it("does not replace a complete or paid provider session", async () => {
    const repository = createRepository("cs_test_complete");
    retrieve.mockResolvedValue(
      stripeSession({
        id: "cs_test_complete",
        payment_status: "paid",
        status: "complete",
        url: null
      }),
    );
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutAlreadyCompleteError"
    });

    expect(repository.retireTerminalCheckout).not.toHaveBeenCalled();
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("retires a newly created session that has no reusable URL", async () => {
    const repository = createRepository();
    create.mockResolvedValue(stripeSession({ url: null }));
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutProviderError"
    });

    expect(repository.retireTerminalCheckout).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ sessionId: "cs_test_123" }),
      "provider_session_unusable",
    );
    expect(repository.markProviderFailure).not.toHaveBeenCalled();
  });

  it("marks a retryable failure without exposing the Stripe error", async () => {
    const repository = createRepository();
    create.mockRejectedValue(new Error("sk_test_secret provider outage"));
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await expect(service.startCheckout(context, contact)).rejects.toEqual(
      expect.objectContaining({
        message: "Unable to start checkout. Please try again.",
        name: "CheckoutProviderError"
      }),
    );
    expect(repository.markProviderFailure).toHaveBeenCalledWith(orderId);
    expect(repository.finalizeCheckout).not.toHaveBeenCalled();
  });

  it("retries provider timeouts with the same durable idempotency identity", async () => {
    const repository = createRepository();
    create
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValueOnce(stripeSession());
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await expect(service.startCheckout(context, contact)).rejects.toMatchObject({
      name: "CheckoutProviderError"
    });
    await expect(service.startCheckout(context, contact)).resolves.toMatchObject({
      orderId
    });

    expect(create.mock.calls[0][1]).toEqual({
      idempotencyKey: `cart-checkout:${orderId}`
    });
    expect(create.mock.calls[1][1]).toEqual({
      idempotencyKey: `cart-checkout:${orderId}`
    });
  });
});
