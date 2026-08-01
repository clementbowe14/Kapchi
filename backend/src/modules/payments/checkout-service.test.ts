import { beforeEach, describe, expect, it, vi } from "vitest";
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

function stripeSession() {
  return {
    id: "cs_test_123",
    customer: "cus_test_123",
    expires_at: 1785600000,
    url: "https://checkout.stripe.com/c/pay/cs_test_123"
  } as Stripe.Checkout.Session;
}

describe("CheckoutService", () => {
  const create = vi.fn();
  const retrieve = vi.fn();

  beforeEach(() => {
    create.mockReset();
    retrieve.mockReset();
  });

  it("uses durable order identity for Stripe idempotency and finalization", async () => {
    const repository = createRepository();
    create.mockResolvedValue(stripeSession());
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    const result = await service.startGuestCheckout(context, contact);

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

    await service.startGuestCheckout(context, contact);

    expect(retrieve).toHaveBeenCalledWith("cs_test_123");
    expect(create).not.toHaveBeenCalled();
  });

  it("marks a retryable failure without exposing the Stripe error", async () => {
    const repository = createRepository();
    create.mockRejectedValue(new Error("sk_test_secret provider outage"));
    const service = new CheckoutService(repository as unknown as CheckoutRepository, {
      checkout: { sessions: { create, retrieve } }
    } as unknown as Pick<Stripe, "checkout">);

    await expect(service.startGuestCheckout(context, contact)).rejects.toEqual(
      expect.objectContaining({
        message: "Unable to start checkout. Please try again.",
        name: "CheckoutProviderError"
      }),
    );
    expect(repository.markProviderFailure).toHaveBeenCalledWith(orderId);
    expect(repository.finalizeCheckout).not.toHaveBeenCalled();
  });
});
