import { describe, expect, it } from "vitest";
import {
  extractStripeWebhookSecret,
  localStripeWebhookUrl,
  redactStripeSecrets,
  requireStripeTestApiKey,
} from "./local-stripe-development.js";

describe("local Stripe development helpers", () => {
  it("accepts test keys and refuses live or absent credentials", () => {
    expect(requireStripeTestApiKey(" sk_test_fixture ")).toBe("sk_test_fixture");
    expect(requireStripeTestApiKey("rk_test_fixture")).toBe("rk_test_fixture");
    expect(() => requireStripeTestApiKey("sk_live_fixture")).toThrow(
      /test-mode API key/,
    );
    expect(() => requireStripeTestApiKey(undefined)).toThrow(/test-mode API key/);
  });

  it("extracts the current listener secret without logging credentials", () => {
    const output =
      "Ready! Your webhook signing secret is whsec_fixture123 (^C to quit)";

    expect(extractStripeWebhookSecret(output)).toBe("whsec_fixture123");
    expect(
      redactStripeSecrets(
        `${output} sk_test_fixture rk_live_fixture`,
      ),
    ).toBe(
      "Ready! Your webhook signing secret is [redacted Stripe webhook secret] (^C to quit) [redacted Stripe API key] [redacted Stripe API key]",
    );
  });

  it("builds a loopback webhook URL and rejects invalid ports", () => {
    expect(localStripeWebhookUrl(undefined)).toBe(
      "http://127.0.0.1:4000/payments/webhooks/stripe",
    );
    expect(localStripeWebhookUrl("4100")).toBe(
      "http://127.0.0.1:4100/payments/webhooks/stripe",
    );
    expect(() => localStripeWebhookUrl("not-a-port")).toThrow(/PORT/);
    expect(() => localStripeWebhookUrl("70000")).toThrow(/PORT/);
  });
});
