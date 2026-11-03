import { describe, expect, it } from "vitest";
import { normalizeStripeShippingDetails } from "./success-state.js";

describe("Stripe shipping address projection", () => {
  it("keeps only normalized U.S. fulfillment fields", () => {
    expect(normalizeStripeShippingDetails({
      address: {
        city: " Boston ",
        country: "us",
        line1: "123 Main St",
        line2: null,
        postal_code: "02108",
        state: "ma"
      },
      name: " Customer Example "
    })).toEqual({
      address: {
        city: "Boston",
        country: "US",
        line1: "123 Main St",
        postalCode: "02108",
        state: "MA"
      },
      name: "Customer Example",
      status: "valid"
    });
  });

  it("classifies missing, malformed, and international addresses without throwing", () => {
    expect(normalizeStripeShippingDetails(null)).toEqual({
      issueCode: "ADDRESS_MISSING", status: "missing"
    });
    expect(normalizeStripeShippingDetails({
      address: { city: "Boston", country: "US", line1: "1 Main", postal_code: "bad", state: "MA" },
      name: "Customer"
    })).toEqual({ issueCode: "ADDRESS_INVALID", status: "invalid" });
    expect(normalizeStripeShippingDetails({
      address: { city: "Toronto", country: "CA", line1: "1 King", postal_code: "M5H", state: "ON" },
      name: "Customer"
    })).toEqual({ issueCode: "ADDRESS_UNSUPPORTED_COUNTRY", status: "invalid" });
  });
});
