import { describe, expect, it } from "vitest";

const requiredEnvironment: NodeJS.ProcessEnv = {
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_JWT_ISSUER: "https://clerk.test",
  CLERK_PUBLISHABLE_KEY: "test-publishable-key",
  CLERK_SECRET_KEY: "test-secret-key",
  CLERK_WEBHOOK_SECRET: "test-webhook-secret",
  DATABASE_MAX_APP_INSTANCES: "3",
  DATABASE_MAX_CONNECTIONS: "20",
  DATABASE_POOL_MAX: "5",
  DATABASE_RESERVED_CONNECTIONS: "5",
  DATABASE_URL: "postgres://user:pass@localhost:5432/kapchi_test",
  REDIS_URL: "redis://localhost:6379",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries({
  ...requiredEnvironment,
  NODE_ENV: "test"
})) {
  process.env[key] = value;
}

const { validateEnvironment } = await import("./env.js");

describe("checkout redirect environment", () => {
  it("keeps localhost defaults for development and test", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "test"
    });

    expect(environment.STRIPE_CHECKOUT_SUCCESS_URL).toBe(
      "http://localhost:3000/checkout/confirmation",
    );
    expect(environment.STRIPE_CHECKOUT_CANCEL_URL).toBe(
      "http://localhost:3000/cart",
    );
  });

  it("requires explicit checkout URLs in production", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: "production"
      }),
    ).toThrow(/STRIPE_CHECKOUT_(SUCCESS|CANCEL)_URL/);
  });

  it("rejects non-HTTPS checkout URLs in production", () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: "production",
        STRIPE_CHECKOUT_CANCEL_URL: "http://kapchi.test/cart",
        STRIPE_CHECKOUT_SUCCESS_URL: "https://kapchi.test/orders"
      }),
    ).toThrow(/STRIPE_CHECKOUT_CANCEL_URL/);
  });

  it("accepts explicit HTTPS checkout URLs in production", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "production",
      STRIPE_CHECKOUT_CANCEL_URL: "https://kapchi.test/cart",
      STRIPE_CHECKOUT_SUCCESS_URL: "https://kapchi.test/orders"
    });

    expect(environment.STRIPE_CHECKOUT_CANCEL_URL).toBe(
      "https://kapchi.test/cart",
    );
    expect(environment.STRIPE_CHECKOUT_SUCCESS_URL).toBe(
      "https://kapchi.test/orders",
    );
  });

  it("reports the resolved env file and explains missing Stripe API keys", () => {
    const environmentWithoutStripeSecret = { ...requiredEnvironment };
    delete environmentWithoutStripeSecret.STRIPE_SECRET_KEY;

    expect(() =>
      validateEnvironment(environmentWithoutStripeSecret, {
        envFileLoaded: true,
        envFilePath: "/srv/kapchi/backend/.env"
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /STRIPE_SECRET_KEY[\s\S]*\/srv\/kapchi\/backend\/\.env \(loaded\)[\s\S]*STRIPE_WEBHOOK_SECRET only verifies webhooks[\s\S]*Stripe CLI authentication is stored separately/,
        )
      }),
    );
  });
});
