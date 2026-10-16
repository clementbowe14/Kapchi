import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envDefaults: Record<string, string> = {
  ASSET_UPLOAD_CALLBACK_SECRET: "test-callback-secret",
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
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test"
};

for (const [key, value] of Object.entries(envDefaults)) {
  process.env[key] = value;
}

const mocks = vi.hoisted(() => ({
  auth: null as
    | null
    | {
        permissions: string[];
        roles: string[];
        userId: string;
      },
  guestCart: null as null | { cartId: string; sessionId: string },
  query: vi.fn()
}));

vi.mock("../../database/index.js", () => ({
  getDatabasePool: () => ({
    query: mocks.query
  })
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61"
}));

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: { auth: unknown }) => {
    request.auth = mocks.auth
      ? {
          claims: {},
          permissions: mocks.auth.permissions,
          roles: mocks.auth.roles,
          sessionId: null,
          token: "test-token",
          userId: mocks.auth.userId
        }
      : null;
  }
}));

vi.mock("../cart/guest-session.js", () => ({
  getGuestCartContext: async () => mocks.guestCart,
  hashSessionId: (sessionId: string) => `hashed-${sessionId}`
}));

const { default: assetsPlugin } = await import("./plugin.js");

const ids = {
  asset: "0f82fc95-66a6-41b9-9ed5-05a5a20e6f61",
  cart: "1d66d9cc-0987-46e1-b719-c3e5a09f5013",
  customizationSet: "fba94989-b950-4087-bac1-8c1ad4970655",
  listing: "396256fa-68f9-4882-934a-5cedffbd8204",
  otherListing: "661f833a-41c5-4ec9-8232-e1883f6be7ed"
};

function assetRow(overrides = {}) {
  return {
    authenticated_user_id: null,
    byte_size: 2048,
    cart_id: ids.cart,
    checksum: null,
    content_type: "image/png",
    context: "customization_image",
    created_by_auth_subject: null,
    expected_pathname: `kapchi/customization_image/${ids.asset}/photo.png`,
    fabric_id: null,
    id: ids.asset,
    listing_customization_set_id: ids.customizationSet,
    listing_id: ids.listing,
    provider: "vercel_blob",
    status: "pending",
    storage_key: null,
    url: null,
    visibility: "private",
    ...overrides
  };
}

async function buildTestServer() {
  const app = fastify({ logger: false });
  await app.register(assetsPlugin);

  return app;
}

describe("assetsPlugin", () => {
  beforeEach(() => {
    mocks.auth = null;
    mocks.guestCart = null;
    mocks.query.mockReset();
  });

  it("rejects unsupported customer upload content types before database work", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        byteSize: 1024,
        cartId: ids.cart,
        contentType: "image/gif",
        context: "customization_image",
        customizationSetId: ids.customizationSet,
        filename: "animated.gif",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();

    await app.close();
  });

  it("requires admin access for catalog listing assets", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        byteSize: 1024,
        contentType: "image/png",
        context: "catalog_listing_image",
        filename: "catalog.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("Admin access");
    expect(mocks.query).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not accept broad permission claims without the store admin role", async () => {
    mocks.auth = {
      permissions: ["assets:write", "catalog:write", "listings:write"],
      roles: ["org:admin"],
      userId: "organization-admin"
    };
    const app = await buildTestServer();
    const response = await app.inject({
      headers: { authorization: "Bearer permission-token" },
      method: "POST",
      payload: {
        byteSize: 1024,
        contentType: "image/png",
        context: "catalog_listing_image",
        filename: "catalog.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an active local actor and audits admin asset intents", async () => {
    mocks.auth = {
      permissions: [],
      roles: ["admin"],
      userId: "store-admin"
    };
    const actorId = "c33f2b22-2af9-4d03-b24b-f86e9b9b98a5";
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: actorId }] })
      .mockResolvedValueOnce({
        rows: [assetRow({
          authenticated_user_id: actorId,
          cart_id: null,
          context: "catalog_listing_image",
          created_by_auth_subject: "store-admin",
          listing_customization_set_id: null,
          visibility: "public_catalog"
        })]
      });
    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "catalog-upload-1"
      },
      method: "POST",
      payload: {
        byteSize: 2048,
        contentType: "image/png",
        context: "catalog_listing_image",
        filename: "catalog.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.query.mock.calls[0][0]).toContain("disabled_at is null");
    expect(mocks.query.mock.calls[1][0]).toContain("insert into admin_audit_events");
    expect(mocks.query.mock.calls[1][1]).toEqual(expect.arrayContaining([
      actorId,
      "store-admin",
      "catalog-upload-1"
    ]));
    await app.close();
  });

  it("requires idempotency identity for an admin asset mutation", async () => {
    mocks.auth = {
      permissions: [],
      roles: ["admin"],
      userId: "store-admin"
    };
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: "c33f2b22-2af9-4d03-b24b-f86e9b9b98a5" }]
    });
    const app = await buildTestServer();
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "POST",
      payload: {
        byteSize: 2048,
        contentType: "image/png",
        context: "catalog_listing_image",
        filename: "catalog.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Idempotency-Key");
    expect(mocks.query).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns a structured conflict for a replayed admin asset key", async () => {
    mocks.auth = {
      permissions: [],
      roles: ["admin"],
      userId: "store-admin"
    };
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: "c33f2b22-2af9-4d03-b24b-f86e9b9b98a5" }]
      })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), {
        code: "23505",
        constraint: "admin_audit_events_idempotency_idx"
      }));
    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "catalog-upload-1"
      },
      method: "POST",
      payload: {
        byteSize: 2048,
        contentType: "image/png",
        context: "catalog_listing_image",
        filename: "catalog.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "IDEMPOTENCY_CONFLICT",
      statusCode: 409
    });
    await app.close();
  });

  it("creates a private pending asset intent for a matching guest cart customization", async () => {
    mocks.guestCart = {
      cartId: ids.cart,
      sessionId: "guest-session"
    };
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            image_max_bytes: 5242880,
            listing_status: "active",
            listing_type: "graduation_stole",
            requires_image: true
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: ids.cart }] })
      .mockResolvedValueOnce({ rows: [assetRow()] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        byteSize: 2048,
        cartId: ids.cart,
        contentType: "image/png",
        context: "customization_image",
        customizationSetId: ids.customizationSet,
        filename: "Class Photo.PNG",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access: "private",
      allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
      assetId: ids.asset,
      maxBytes: 5242880
    });
    expect(response.json().pathname).toContain(ids.asset);
    expect(JSON.parse(response.json().clientPayload)).toMatchObject({
      assetId: ids.asset,
      cartId: ids.cart,
      context: "customization_image",
      visibility: "private"
    });
    expect(mocks.query.mock.calls[1][1]).toEqual([
      ids.cart,
      "hashed-guest-session"
    ]);
    expect(mocks.query.mock.calls[1][0]).toContain("expires_at > now()");
    expect(mocks.query.mock.calls[1][0]).not.toContain("insert into carts");
    expect(mocks.query).toHaveBeenCalledTimes(3);

    await app.close();
  });

  it("rejects customer uploads when the requested cart is not owned and active", async () => {
    mocks.guestCart = {
      cartId: ids.cart,
      sessionId: "guest-session"
    };
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            image_max_bytes: 5242880,
            listing_status: "active",
            listing_type: "graduation_stole",
            requires_image: true
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        byteSize: 2048,
        cartId: ids.cart,
        contentType: "image/png",
        context: "customization_image",
        customizationSetId: ids.customizationSet,
        filename: "photo.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("requested guest cart");
    expect(mocks.query).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("rejects customer uploads when the customization does not require an image", async () => {
    mocks.guestCart = {
      cartId: ids.cart,
      sessionId: "guest-session"
    };
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          enabled: true,
          image_max_bytes: null,
          listing_status: "active",
          listing_type: "graduation_stole",
          requires_image: false
        }
      ]
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        byteSize: 2048,
        cartId: ids.cart,
        contentType: "image/png",
        context: "customization_image",
        customizationSetId: ids.customizationSet,
        filename: "photo.png",
        listingId: ids.listing
      },
      url: "/upload-intents"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("does not accept image uploads");

    await app.close();
  });

  it("authorizes Blob upload tokens only when the pending asset matches the caller and pathname", async () => {
    mocks.guestCart = {
      cartId: ids.cart,
      sessionId: "guest-session"
    };
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            image_max_bytes: 5242880,
            listing_status: "active",
            listing_type: "graduation_stole",
            requires_image: true
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: ids.cart }] })
      .mockResolvedValueOnce({ rows: [assetRow()] });
    const tokenPayload = JSON.stringify({
      assetId: ids.asset,
      byteSize: 2048,
      cartId: ids.cart,
      contentType: "image/png",
      context: "customization_image",
      customizationSetId: ids.customizationSet,
      filename: "photo.png",
      issuedAt: new Date().toISOString(),
      listingId: ids.listing,
      visibility: "private"
    });

    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {
        clientPayload: tokenPayload,
        pathname: `kapchi/customization_image/${ids.asset}/photo.png`
      },
      url: "/upload-token-authorizations"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
      maximumSizeInBytes: 5242880,
      tokenPayload
    });
    expect(mocks.query.mock.calls[2][1]).toEqual([ids.asset]);

    await app.close();
  });

  it("finalizes a Vercel Blob upload into provider-neutral asset metadata", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [assetRow()]
      })
      .mockResolvedValueOnce({
        rows: [
          assetRow({
            checksum: "etag-123",
            status: "uploaded",
            storage_key: `kapchi/customization_image/${ids.asset}/photo.png`,
            url: "https://blob.example/photo.png"
          })
        ]
      });
    const tokenPayload = JSON.stringify({
      assetId: ids.asset,
      byteSize: 2048,
      cartId: ids.cart,
      contentType: "image/png",
      context: "customization_image",
      customizationSetId: ids.customizationSet,
      filename: "photo.png",
      issuedAt: new Date().toISOString(),
      listingId: ids.listing,
      visibility: "private"
    });

    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "x-kapchi-upload-callback-secret": "test-callback-secret"
      },
      method: "POST",
      payload: {
        blob: {
          contentType: "image/png",
          etag: "etag-123",
          pathname: `kapchi/customization_image/${ids.asset}/photo.png`,
          size: 2048,
          url: "https://blob.example/photo.png"
        },
        tokenPayload
      },
      url: "/upload-completions"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asset: {
        byteSize: 2048,
        checksum: "etag-123",
        contentType: "image/png",
        context: "customization_image",
        id: ids.asset,
        provider: "vercel_blob",
        status: "uploaded",
        storageKey: `kapchi/customization_image/${ids.asset}/photo.png`,
        url: null,
        visibility: "private"
      },
      assetId: ids.asset
    });
    expect(mocks.query.mock.calls[1][1]).toEqual([
      ids.asset,
      `kapchi/customization_image/${ids.asset}/photo.png`,
      "https://blob.example/photo.png",
      "image/png",
      2048,
      "etag-123",
      "private",
      JSON.stringify({
        completedBy: "vercel_blob_callback",
        downloadUrl: null
      })
    ]);

    await app.close();
  });

  it("rejects upload completion when token payload does not match the pending asset", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        assetRow({
          listing_id: ids.otherListing
        })
      ]
    });
    const tokenPayload = JSON.stringify({
      assetId: ids.asset,
      byteSize: 2048,
      cartId: ids.cart,
      contentType: "image/png",
      context: "customization_image",
      customizationSetId: ids.customizationSet,
      filename: "photo.png",
      issuedAt: new Date().toISOString(),
      listingId: ids.listing,
      visibility: "private"
    });

    const app = await buildTestServer();
    const response = await app.inject({
      headers: {
        "x-kapchi-upload-callback-secret": "test-callback-secret"
      },
      method: "POST",
      payload: {
        blob: {
          contentType: "image/png",
          etag: "etag-123",
          pathname: "kapchi/customization_image/photo.png",
          size: 2048,
          url: "https://blob.example/photo.png"
        },
        tokenPayload
      },
      url: "/upload-completions"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("pending asset record");
    expect(mocks.query).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("requires the configured callback secret for upload completion", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      payload: {},
      url: "/upload-completions"
    });

    expect(response.statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();

    await app.close();
  });
});
