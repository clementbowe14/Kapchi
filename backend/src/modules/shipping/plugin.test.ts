import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShippingExportRepositoryPort } from "./repository.js";

vi.mock("../auth/index.js", () => ({
  authMiddleware: async (request: {
    auth: unknown;
    headers: { authorization?: string };
  }) => {
    const token = request.headers.authorization;
    request.auth = token ? {
      claims: {}, permissions: [], roles: token === "Bearer admin-token" ? ["admin"] : ["customer"],
      sessionId: null, token, userId: "clerk_admin"
    } : null;
  }
}));

const [{ default: adminBoundaryPlugin }, { createShippingPlugin }] = await Promise.all([
  import("../admin-auth/boundary.js"),
  import("./plugin.js")
]);

const batchId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const actor = { authSubject: "clerk_admin", userId: "33333333-3333-4333-8333-333333333333" };

function repository() {
  return {
    correctAddress: vi.fn(async () => ({ replayed: false, revision: 4 })),
    createBatch: vi.fn(async () => ({
      batchId, downloadPath: `/admin/shipping/export-batches/${batchId}/file`,
      expiresAt: "2026-12-03T12:00:00.000Z", filename: `kapchi-pirate-ship-${batchId}.csv`,
      mappingVersion: 1 as const, replayed: false, rowCount: 1
    })),
    detail: vi.fn(),
    download: vi.fn(async () => ({
      bytes: Buffer.from("\uFEFFcsv"), filename: `kapchi-pirate-ship-${batchId}.csv`, sha256: "a".repeat(64)
    })),
    list: vi.fn(async () => ({ batches: [], nextCursor: null })),
    mutateBatch: vi.fn(),
    preflight: vi.fn(async () => ({ candidates: [{ codes: [], eligible: true, orderId }] })),
    purgeExpired: vi.fn(),
    resolveActor: vi.fn(async () => actor)
  } as unknown as ShippingExportRepositoryPort;
}

async function server(repo: ShippingExportRepositoryPort) {
  const app = fastify({ logger: false });
  await app.register(adminBoundaryPlugin);
  await app.register(createShippingPlugin({ repository: repo }), { prefix: "/admin" });
  return app;
}

describe("admin shipping export plugin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a bounded export with a durable idempotency key", async () => {
    const repo = repository();
    const app = await server(repo);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token", "idempotency-key": "shipping-export-key-0001" },
      method: "POST",
      payload: { orders: [{
        expectedRevision: 3, orderId,
        package: { heightInches: 2, lengthInches: 10, weightOunces: 12.5, widthInches: 8 }
      }] },
      url: "/admin/shipping/export-batches"
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ batchId, rowCount: 1 });
    expect(repo.createBatch).toHaveBeenCalledWith(
      actor, expect.any(Array), "shipping-export-key-0001", expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(String),
    );
    await app.close();
  });

  it("serves files with private no-store and nosniff headers", async () => {
    const repo = repository();
    const app = await server(repo);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" }, method: "GET",
      url: `/admin/shipping/export-batches/${batchId}/file`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toContain(`kapchi-pirate-ship-${batchId}.csv`);
    await app.close();
  });

  it.each([
    { authorization: undefined, expected: 401 },
    { authorization: "Bearer customer-token", expected: 403 }
  ])("guards bulk customer PII with admin fulfillment access", async ({ authorization, expected }) => {
    const repo = repository();
    const app = await server(repo);
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "POST", payload: { orderIds: [orderId] }, url: "/admin/shipping/export-candidates"
    });
    expect(response.statusCode).toBe(expected);
    expect(repo.preflight).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns allowlisted validation errors without submitted values", async () => {
    const repo = repository();
    const app = await server(repo);
    const secret = "private-address-canary";
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token", "idempotency-key": "short" },
      method: "POST", payload: { orders: [{ orderId, secret }] },
      url: "/admin/shipping/export-batches"
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
    await app.close();
  });

  it("rejects package measurements with more than two decimal places", async () => {
    const repo = repository();
    const app = await server(repo);
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "shipping-export-key-precision"
      },
      method: "POST",
      payload: { orders: [{
        expectedRevision: 3,
        orderId,
        package: {
          heightInches: 2,
          lengthInches: 10,
          weightOunces: 12.345,
          widthInches: 8
        }
      }] },
      url: "/admin/shipping/export-batches"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(repo.createBatch).not.toHaveBeenCalled();
    await app.close();
  });
});
