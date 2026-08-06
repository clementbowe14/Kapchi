import type { Pool } from "pg";
import type { RedisClientType } from "redis";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../types/auth.js";
import type { CartClaimRepository } from "./claim-repository.js";

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

const [{ CartClaimService }, { buildGuestCartItemsKey, buildGuestSessionKey }] =
  await Promise.all([import("./claim-service.js"), import("./guest-session.js")]);

const guestContext = {
  cartId: "53fcaccc-1baa-4072-abbb-c51d20f3588b",
  sessionId: "valid_session_id_abcdefghijklmnopqrstuvwxyz123456789"
};
const auth = {
  claims: {
    email: "Customer@Example.com",
    first_name: "Kapchi",
    image_url: "https://images.clerk.test/customer.png",
    last_name: "Customer",
    phone_number: "+15550102020"
  },
  permissions: [],
  roles: [],
  sessionId: "authenticated_session",
  token: "secret-bearer-token",
  userId: "user_clerk_123"
} as unknown as AuthContext;
const view = {
  cartId: guestContext.cartId,
  items: [],
  subtotalCents: 0,
  warnings: []
};

function createService(redisError?: Error) {
  const claim = vi.fn(async () => view);
  const repository = { claim } as unknown as CartClaimRepository;
  const del = vi.fn(async () => {
    if (redisError) throw redisError;
    return 2;
  });
  const redis = { del } as unknown as RedisClientType;
  const logger = { warn: vi.fn() };
  const pool = { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
  const service = new CartClaimService(pool, redis, logger as never, repository);

  return { claim, del, logger, service };
}

describe("CartClaimService", () => {
  it("uses only verified claims and cleans guest Redis keys after commit", async () => {
    const { claim, del, service } = createService();

    await expect(service.claim(auth, guestContext)).resolves.toEqual(view);

    expect(claim).toHaveBeenCalledWith(
      {
        authSubject: "user_clerk_123",
        avatarUrl: "https://images.clerk.test/customer.png",
        displayName: "Kapchi Customer",
        email: "customer@example.com",
        phone: "+15550102020"
      },
      guestContext,
    );
    expect(JSON.stringify(claim.mock.calls)).not.toContain("secret-bearer-token");
    expect(del).toHaveBeenCalledWith([
      buildGuestSessionKey(guestContext.sessionId),
      buildGuestCartItemsKey(guestContext.cartId)
    ]);
  });

  it("keeps a committed claim successful when disposable cleanup fails", async () => {
    const { logger, service } = createService(
      new Error("redis://secret-host unavailable"),
    );

    await expect(service.claim(auth, guestContext)).resolves.toEqual(view);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        cartId: guestContext.cartId,
        cleanupError: { name: "Error" }
      },
      "Guest cart cleanup failed after durable claim",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-host");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      guestContext.sessionId,
    );
  });

  it("does not touch Redis when there is no guest context to remove", async () => {
    const { del, service } = createService();

    await service.claim(auth, null);

    expect(del).not.toHaveBeenCalled();
  });
});
