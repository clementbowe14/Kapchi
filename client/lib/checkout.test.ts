import { describe, expect, it } from "vitest";

import {
  cartNeedsReview,
  CheckoutApiError,
  checkoutErrorMessage,
  getSafeHostedCheckoutUrl,
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
      subtotalCents: 8500,
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
  });
});
