import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripeClient } from "./stripe-client.js";
import type { StripeConstructor } from "./stripe-client.js";

vi.mock("../../config/index.js", () => ({
  config: {
    payments: {
      stripe: {
        apiVersion: "2026-02-25.clover",
        secretKey: "sk_test_mocked_default_config",
        webhookSecret: "whsec_test"
      }
    }
  }
}));

const stripeClients: StripeClientMock[] = [];

class StripeClientMock {
  readonly apiKey: string;
  readonly config: unknown;

  constructor(apiKey: string, config: unknown) {
    this.apiKey = apiKey;
    this.config = config;
    stripeClients.push(this);
  }
}

function createAppConfig() {
  return {
    payments: {
      checkout: {
        cancelUrl: "https://kapchi.test/cart",
        successUrl: "https://kapchi.test/orders"
      },
      stripe: {
        apiVersion: "2026-02-25.clover",
        secretKey: "sk_test_from_config",
        webhookSecret: "whsec_test"
      }
    }
  };
}

describe("createStripeClient", () => {
  beforeEach(() => {
    stripeClients.length = 0;
  });

  it("creates a Stripe SDK client from backend config values", () => {
    const client = createStripeClient({
      appConfig: createAppConfig(),
      StripeCtor: StripeClientMock as unknown as StripeConstructor
    });

    expect(client).toBe(stripeClients[0]);
    expect(stripeClients[0]).toMatchObject({
      apiKey: "sk_test_from_config",
      config: {
        apiVersion: "2026-02-25.clover"
      }
    });
  });

  it("defaults to the validated backend app config", () => {
    createStripeClient({
      StripeCtor: StripeClientMock as unknown as StripeConstructor
    });

    expect(stripeClients[0]).toMatchObject({
      apiKey: "sk_test_mocked_default_config",
      config: {
        apiVersion: "2026-02-25.clover"
      }
    });
  });
});
