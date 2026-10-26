import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAssetRepositoryPort } from "./repository.js";
import type { PrivateAssetLookup, PrivateAssetReader } from "./types.js";

const requiredEnvironment = {
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_JWT_ISSUER: "https://clerk.test",
  CLERK_PUBLISHABLE_KEY: "test-publishable-key",
  CLERK_SECRET_KEY: "test-secret-key",
  CLERK_WEBHOOK_SECRET: "test-webhook-secret",
  DATABASE_URL: "postgres://user:pass@localhost:5432/kapchi_test",
  NODE_ENV: "test",
  REDIS_URL: "redis://localhost:6379",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};
Object.assign(process.env, requiredEnvironment);

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: {
    auth: unknown;
    headers: { authorization?: string };
  }) => {
    const token = request.headers.authorization;
    request.auth = token
      ? {
          claims: {},
          permissions: [],
          roles: token === "Bearer admin-token" ? ["admin"] : ["customer"],
          sessionId: null,
          token,
          userId: "user_admin"
        }
      : null;
  }
}));

const [{ createAdminAssetPlugin }] = await Promise.all([
  import("./plugin.js")
]);

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const storageKey = `kapchi/customization_image/${assetId}/crest.png`;
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nzsAAAAASUVORK5CYII=",
    "base64",
  ),
);

function lookup(overrides: Partial<PrivateAssetLookup> = {}): PrivateAssetLookup {
  return {
    asset: {
      byteSize: png.byteLength,
      checksum: "etag-1",
      contentType: "image/png",
      context: "customization_image",
      expectedPathname: storageKey,
      id: assetId,
      originalFilename: "Customer Crest.png",
      provider: "vercel_blob",
      status: "attached",
      storageKey,
      visibility: "private"
    },
    canonicalAssetId: assetId,
    orderId,
    orderItemId,
    paidAt: "2026-10-26T12:00:00.000Z",
    snapshotAssetId: assetId,
    ...overrides
  };
}

function providerStream() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(png);
      controller.close();
    }
  });
}

describe("admin private asset routes", () => {
  let current: PrivateAssetLookup;
  let repository: AdminAssetRepositoryPort;
  let reader: PrivateAssetReader;

  beforeEach(() => {
    current = lookup();
    repository = {
      findActor: vi.fn(async (subject) => ({ authSubject: subject, userId: orderId })),
      lookup: vi.fn(async () => current),
      recordAccess: vi.fn(async () => "44444444-4444-4444-8444-444444444444"),
      updateDelivery: vi.fn(async () => undefined)
    };
    reader = {
      configured: true,
      open: vi.fn(async () => ({
        checksum: "etag-1",
        contentType: "image/png",
        pathname: storageKey,
        size: png.byteLength,
        stream: providerStream()
      }))
    };
  });

  async function build() {
    const app = fastify({ logger: false });
    await app.register(
      createAdminAssetPlugin({
        config: {
          crossOriginPolicy: "same-site",
          idleTimeoutMs: 1000,
          maxBytes: 1024,
          openTimeoutMs: 1000,
          totalTimeoutMs: 5000
        },
        readers: { vercel_blob: reader },
        repository
      }),
      { prefix: "/admin/orders" },
    );
    return app;
  }

  it.each([
    { authorization: undefined, statusCode: 401 },
    { authorization: "Bearer customer-token", statusCode: 403 }
  ])("denies unauthorized metadata access", async ({ authorization, statusCode }) => {
    const app = await build();
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset`
    });

    expect(response.statusCode).toBe(statusCode);
    expect(repository.findActor).not.toHaveBeenCalled();
    expect(repository.lookup).not.toHaveBeenCalled();
    expect(reader.open).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns DB-only metadata without exposing provider coordinates", async () => {
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      asset: { id: assetId, filename: "Customer Crest.png" },
      retrieval: { eligibility: "eligible" }
    });
    expect(response.body).not.toContain(storageKey);
    expect(response.body).not.toContain("etag-1");
    expect(reader.open).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an active local administrator profile", async () => {
    vi.mocked(repository.findActor).mockResolvedValueOnce(null);
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset`
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("ADMIN_ACTOR_UNAVAILABLE");
    expect(repository.lookup).not.toHaveBeenCalled();
    await app.close();
  });

  it("streams a validated image with defensive headers and durable audit", async () => {
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset/content?disposition=attachment`
    });

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload)).toEqual(Buffer.from(png));
    expect(response.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-length": String(png.byteLength),
      "content-type": "image/png",
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff"
    });
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(repository.recordAccess).toHaveBeenCalledWith(expect.objectContaining({
      assetId,
      deliveryStatus: "streaming",
      disposition: "attachment",
      outcome: "opened",
      reasonCode: null
    }));
    await vi.waitFor(() => {
      expect(repository.updateDelivery).toHaveBeenCalledWith(
        "44444444-4444-4444-8444-444444444444",
        "completed",
        png.byteLength,
      );
    });
    await app.close();
  });

  it("audits an unpaid-order denial without opening the provider", async () => {
    current = lookup({ paidAt: null });
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset/content`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("ORDER_NOT_PURCHASED");
    expect(repository.recordAccess).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStatus: "not_started",
      outcome: "denied",
      reasonCode: "ORDER_NOT_PURCHASED"
    }));
    expect(reader.open).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when the opening audit cannot be persisted", async () => {
    vi.mocked(repository.recordAccess).mockRejectedValueOnce(
      Object.assign(new Error("private database detail"), { code: "08006" }),
    );
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset/content`
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("PRIVATE_ASSET_SERVICE_UNAVAILABLE");
    expect(response.body).not.toContain("private database detail");
    await app.close();
  });

  it("rejects range delivery before provider access", async () => {
    const app = await build();
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        range: "bytes=0-10"
      },
      method: "GET",
      url: `/admin/orders/${orderId}/items/${orderItemId}/customization-asset/content`
    });

    expect(response.statusCode).toBe(416);
    expect(response.json().error).toBe("RANGE_NOT_SUPPORTED");
    expect(reader.open).not.toHaveBeenCalled();
    await app.close();
  });
});
