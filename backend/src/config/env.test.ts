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

const productionEnvironment: NodeJS.ProcessEnv = {
  ...requiredEnvironment,
  ASSET_UPLOAD_CALLBACK_KEY_ID_CURRENT: "callback_current_2026",
  ASSET_UPLOAD_CALLBACK_SECRET_CURRENT: "c".repeat(32),
  BLOB_READ_WRITE_TOKEN: "vercel_blob_live_token",
  CLERK_AUTHORIZED_PARTIES: "https://shop.kapchi.example",
  CLERK_JWKS_URL: "https://clerk.kapchi.example/.well-known/jwks.json",
  CLERK_JWT_AUDIENCE: "https://api.kapchi.example",
  CLERK_JWT_ISSUER: "https://clerk.kapchi.example",
  CLERK_PUBLISHABLE_KEY: "pk_live_kapchi",
  CLERK_SECRET_KEY: "sk_live_kapchi",
  CLERK_WEBHOOK_SECRET: "c".repeat(32),
  CORS_ALLOWED_ORIGINS: "https://shop.kapchi.example",
  DATABASE_DIRECT_URL: "postgres://user@db.example:5432/kapchi",
  DATABASE_SSL_MODE: "require",
  NODE_ENV: "production",
  ORDER_LOOKUP_BASE_URL: "https://shop.kapchi.example",
  REDIS_URL: "rediss://redis.example:6379",
  RELEASE_DEPLOYMENT_ID: "dpl_test_fixture",
  RELEASE_SHA: "abc1234",
  CRON_SECRET: "r".repeat(32),
  STRIPE_CHECKOUT_CANCEL_URL: "https://shop.kapchi.example/cart",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://shop.kapchi.example/orders",
  STRIPE_SECRET_KEY: "sk_live_123",
  STRIPE_WEBHOOK_SECRET: "s".repeat(32)
};

for (const [key, value] of Object.entries({
  ...requiredEnvironment,
  NODE_ENV: "test"
})) {
  process.env[key] = value;
}

const { validateEnvironment } = await import("./env.js");

describe("checkout redirect environment", () => {
  it("keeps guest analytics off by default and validates the optional backend secret in bytes", () => {
    expect(validateEnvironment(requiredEnvironment).GUEST_ANALYTICS_COOKIE_SECRET).toBeUndefined();
    expect(validateEnvironment(productionEnvironment).GUEST_ANALYTICS_COOKIE_SECRET).toBeUndefined();
    const secret = "\u00e9".repeat(16);
    expect(validateEnvironment({
      ...requiredEnvironment,
      GUEST_ANALYTICS_COOKIE_SECRET: secret
    }).GUEST_ANALYTICS_COOKIE_SECRET).toBe(secret);
    expect(() => validateEnvironment({
      ...requiredEnvironment,
      GUEST_ANALYTICS_COOKIE_SECRET: "short-private-value"
    })).toThrow(/GUEST_ANALYTICS_COOKIE_SECRET.*32 bytes/);
    expect(() => validateEnvironment({
      ...requiredEnvironment,
      GUEST_ANALYTICS_COOKIE_SECRET: "short-private-value"
    })).not.toThrow(/short-private-value/);
  });

  it("keeps private asset provider credentials optional", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "test"
    });

    expect(environment.BLOB_READ_WRITE_TOKEN).toBeUndefined();
    expect(environment.ASSET_PRIVATE_OPEN_TIMEOUT_MS).toBe(5000);
    expect(environment.ASSET_PRIVATE_IDLE_TIMEOUT_MS).toBe(15000);
    expect(environment.ASSET_PRIVATE_TOTAL_TIMEOUT_MS).toBe(60000);
    expect(environment.ASSET_PRIVATE_CROSS_ORIGIN_POLICY).toBe("same-site");
  });

  it("rejects unsafe private asset timeout and resource-policy values", () => {
    expect(() => validateEnvironment({
      ...requiredEnvironment,
      ASSET_PRIVATE_OPEN_TIMEOUT_MS: "999",
      NODE_ENV: "test"
    })).toThrow(/ASSET_PRIVATE_OPEN_TIMEOUT_MS/);
    expect(() => validateEnvironment({
      ...requiredEnvironment,
      ASSET_PRIVATE_CROSS_ORIGIN_POLICY: "allow-all",
      NODE_ENV: "test"
    })).toThrow(/ASSET_PRIVATE_CROSS_ORIGIN_POLICY/);
  });

  it("starts without a shipping-provider credential", () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "test"
    });

    expect(environment).not.toHaveProperty("SHIPPO_API_KEY");
  });

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
      ...productionEnvironment
    });

    expect(environment.STRIPE_CHECKOUT_CANCEL_URL).toBe(
      "https://shop.kapchi.example/cart",
    );
    expect(environment.STRIPE_CHECKOUT_SUCCESS_URL).toBe(
      "https://shop.kapchi.example/orders",
    );
  });

  it("accepts Vercel system release identity in production", () => {
    const environment = { ...productionEnvironment };
    delete environment.RELEASE_DEPLOYMENT_ID;
    delete environment.RELEASE_SHA;

    expect(validateEnvironment({
      ...environment,
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: "dpl_system_fixture",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "a".repeat(40)
    })).toMatchObject({
      VERCEL_DEPLOYMENT_ID: "dpl_system_fixture",
      VERCEL_GIT_COMMIT_SHA: "a".repeat(40)
    });
  });

  it("requires an exact secure production origin and independent Clerk trust claims", () => {
    expect(validateEnvironment(productionEnvironment)).toMatchObject({
      CLERK_AUTHORIZED_PARTIES: "https://shop.kapchi.example",
      CLERK_JWT_AUDIENCE: "https://api.kapchi.example",
      CORS_ALLOWED_ORIGINS: "https://shop.kapchi.example"
    });

    for (const invalidOrigin of ["*", "http://shop.kapchi.example", "https://shop.kapchi.example/path", "https://shop.kapchi.example,https://shop.kapchi.example"]) {
      expect(() => validateEnvironment({ ...productionEnvironment, CORS_ALLOWED_ORIGINS: invalidOrigin })).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
  });

  it("rejects insecure production credentials and provider connections", () => {
    expect(() => validateEnvironment({ ...productionEnvironment, STRIPE_SECRET_KEY: "sk_test_123" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => validateEnvironment({ ...productionEnvironment, REDIS_URL: "redis:\/\/redis.example:6379" })).toThrow(/REDIS_URL/);
    expect(() => validateEnvironment({ ...productionEnvironment, DATABASE_SSL_MODE: "no-verify" })).toThrow(/DATABASE_SSL_MODE/);
    expect(() => validateEnvironment({ ...productionEnvironment, ASSET_UPLOAD_CALLBACK_SECRET_CURRENT: "short" })).toThrow(/ASSET_UPLOAD_CALLBACK_SECRET_CURRENT/);
    expect(() => validateEnvironment({ ...productionEnvironment, CRON_SECRET: "short" })).toThrow(/CRON_SECRET/);
  });

  it("validates the transactional order lookup origin", () => {
    expect(validateEnvironment({
      ...requiredEnvironment,
      NODE_ENV: "test"
    }).ORDER_LOOKUP_BASE_URL).toBe("http://localhost:3000");

    for (const unsafe of [
      "http://shop.example.test",
      "https://user:password@shop.example.test",
      "https://shop.example.test?order=secret",
      "https://shop.example.test#order-secret"
    ]) {
      expect(() => validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: "test",
        ORDER_LOOKUP_BASE_URL: unsafe
      })).toThrow(/ORDER_LOOKUP_BASE_URL/);
    }
  });

  it("requires an HTTPS order lookup origin in production", () => {
    expect(() => validateEnvironment({
      ...productionEnvironment,
      ORDER_LOOKUP_BASE_URL: "http://localhost:3000",
    })).toThrow(/ORDER_LOOKUP_BASE_URL/);

    expect(validateEnvironment({
      ...productionEnvironment,
      ORDER_LOOKUP_BASE_URL: "https://shop.kapchi.test/base/path",
    }).ORDER_LOOKUP_BASE_URL).toBe("https://shop.kapchi.test/base/path");
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
