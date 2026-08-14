import { describe, expect, it } from "vitest";

import {
  cartNeedsReview,
  CheckoutApiError,
  checkoutErrorMessage,
  getSafeHostedCheckoutUrl,
  isRetryableCheckoutError,
  parseCartView,
  validateCheckoutContact,
} from "./checkout";

describe("checkout helpers", () => {
  it("requires both contact values for guests", () => {
    expect(
      validateCheckoutContact({
        customerEmail: "",
        customerPhone: "",
        isSignedIn: false,
        preferredContactMethod: "email",
      }),
    ).toEqual({
      email: "Enter your email address.",
      phone: "Enter your phone number.",
    });

    expect(
      validateCheckoutContact({
        customerEmail: "guest@example.com",
        customerPhone: "+1 (555) 010-1010",
        isSignedIn: false,
        preferredContactMethod: "phone",
      }),
    ).toEqual({});
  });

  it("allows account checkout without a phone only when email is preferred", () => {
    expect(
      validateCheckoutContact({
        customerEmail: "member@example.com",
        customerPhone: "",
        isSignedIn: true,
        preferredContactMethod: "email",
      }),
    ).toEqual({});

    expect(
      validateCheckoutContact({
        customerEmail: "member@example.com",
        customerPhone: "",
        isSignedIn: true,
        preferredContactMethod: "phone",
      }),
    ).toEqual({ phone: "Enter your phone number." });
  });

  it("accepts only HTTPS Stripe-hosted checkout URLs", () => {
    expect(
      getSafeHostedCheckoutUrl(
        "https://checkout.stripe.com/c/pay/cs_test_checkout",
      ),
    ).toBe("https://checkout.stripe.com/c/pay/cs_test_checkout");
    expect(
      getSafeHostedCheckoutUrl("https://checkout.stripe.com.attacker.test/pay"),
    ).toBeNull();
    expect(
      getSafeHostedCheckoutUrl("http://checkout.stripe.com/c/pay/test"),
    ).toBeNull();
  });

  it("parses review states without trusting client prices", () => {
    const cart = parseCartView({
      cartId: "cart-1",
      items: [
        {
          cartItemId: "item-1",
          currency: "usd",
          customizationSetId: "customization-1",
          customizationSummary: {},
          fabricId: null,
          listingId: "listing-1",
          listingPriceVariantId: "variant-1",
          listingSlug: "stole",
          quantity: 1,
          title: "Graduation Stole",
          unitAmountCents: 8500,
          validationStatus: "unavailable",
        },
      ],
      lineItemCount: 1,
      revision: 1,
      subtotalCents: 8500,
      totalQuantity: 1,
    });

    expect(cartNeedsReview(cart)).toBe(true);
    expect(cart.items[0]).toMatchObject({
      title: "Graduation Stole",
      validationStatus: "unavailable",
    });
  });

  it("maps retryable provider failures to customer-safe copy", () => {
    const error = new CheckoutApiError(
      "CHECKOUT_PROVIDER_ERROR",
      502,
      "private provider detail",
    );

    expect(checkoutErrorMessage(error)).toContain("temporarily unavailable");
    expect(checkoutErrorMessage(error)).not.toContain("private provider detail");
    expect(isRetryableCheckoutError(error)).toBe(true);
  });

  it("maps catalog failures to safe non-retryable guidance", () => {
    const error = new CheckoutApiError(
      "CHECKOUT_CATALOG_UNAVAILABLE",
      503,
      "resource_missing line_items[0][price] price_private_value",
    );

    expect(checkoutErrorMessage(error)).toBe(
      "Secure checkout is unavailable for one or more items. Please contact Kapchi support.",
    );
    expect(checkoutErrorMessage(error)).not.toContain("resource_missing");
    expect(checkoutErrorMessage(error)).not.toContain("price_private_value");
    expect(isRetryableCheckoutError(error)).toBe(false);
  });
});
