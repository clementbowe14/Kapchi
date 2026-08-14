import { describe, expect, it, vi } from "vitest";
import {
  CheckoutProviderPriceUnavailableError,
  StripeCheckoutProvider
} from "./checkout-provider.js";

const checkoutInput = {
  cancelUrl: "https://kapchi.test/cart",
  customerEmail: "customer@example.com",
  lines: [{ quantity: 2, stripePriceId: "price_test_stole" }],
  orderId: "order-123",
  successUrl: "https://kapchi.test/orders"
};

describe("StripeCheckoutProvider", () => {
  it("maps the provider-neutral checkout request to Stripe", async () => {
    const create = vi.fn(async () => ({
      customer: "cus_test_123",
      expires_at: 1_786_105_800,
      id: "cs_test_123",
      payment_status: "unpaid",
      status: "open",
      url: "https://checkout.stripe.test/session"
    }));
    const provider = new StripeCheckoutProvider({
      checkout: { sessions: { create } }
    } as never);

    const session = await provider.createSession(
      checkoutInput,
      "cart-checkout:order-123",
    );

    expect(create).toHaveBeenCalledWith(
      {
        cancel_url: "https://kapchi.test/cart",
        client_reference_id: "order-123",
        customer_email: "customer@example.com",
        line_items: [{ price: "price_test_stole", quantity: 2 }],
        metadata: { order_id: "order-123" },
        mode: "payment",
        payment_intent_data: { metadata: { order_id: "order-123" } },
        success_url: "https://kapchi.test/orders"
      },
      { idempotencyKey: "cart-checkout:order-123" },
    );
    expect(session).toEqual({
      customerId: "cus_test_123",
      expiresAt: new Date(1_786_105_800_000),
      id: "cs_test_123",
      paymentStatus: "unpaid",
      status: "open",
      url: "https://checkout.stripe.test/session"
    });
  });

  it("retrieves and normalizes an existing Stripe session", async () => {
    const retrieve = vi.fn(async () => ({
      customer: null,
      expires_at: null,
      id: "cs_test_existing",
      payment_status: "paid",
      status: "complete",
      url: null
    }));
    const provider = new StripeCheckoutProvider({
      checkout: { sessions: { retrieve } }
    } as never);

    const session = await provider.retrieveSession("cs_test_existing");

    expect(retrieve).toHaveBeenCalledWith("cs_test_existing");
    expect(session).toEqual({
      customerId: null,
      expiresAt: null,
      id: "cs_test_existing",
      paymentStatus: "paid",
      status: "complete",
      url: null
    });
  });

  it.each([
    "line_items[0][price]",
    "line_items[12].price",
    "line_items.3.price"
  ])("sanitizes a missing Checkout line item Price at %s", async (param) => {
    const create = vi.fn(async () => {
      throw Object.assign(
        new Error("No such price: price_private_provider_value"),
        {
          code: "resource_missing",
          param,
          raw: { request_log_url: "https://dashboard.stripe.test/private" }
        },
      );
    });
    const provider = new StripeCheckoutProvider({
      checkout: { sessions: { create } }
    } as never);

    const result = provider.createSession(
      checkoutInput,
      "cart-checkout:order-123",
    );

    await expect(result).rejects.toBeInstanceOf(
      CheckoutProviderPriceUnavailableError,
    );
    await expect(result).rejects.toMatchObject({
      code: "resource_missing",
      message: "A checkout line item Price is unavailable.",
      name: "CheckoutProviderPriceUnavailableError"
    });
  });

  it.each([
    { code: "resource_missing", param: "customer" },
    { code: "resource_missing", param: "line_items[0][quantity]" },
    {
      code: "resource_missing",
      param: "line_items[0][price_data][product]"
    },
    { code: "resource_missing", param: "price" },
    { code: "authentication_error" },
    { code: "rate_limit", param: "line_items[0][price]" },
    { code: "api_error", statusCode: 500 },
    { code: "ETIMEDOUT" },
    { code: "resource_missing" }
  ])("preserves nonmatching provider failures %#", async (details) => {
    const providerError = Object.assign(
      new Error("private provider failure details"),
      details,
    );
    const create = vi.fn(async () => {
      throw providerError;
    });
    const provider = new StripeCheckoutProvider({
      checkout: { sessions: { create } }
    } as never);

    await expect(
      provider.createSession(checkoutInput, "cart-checkout:order-123"),
    ).rejects.toBe(providerError);
  });
});
