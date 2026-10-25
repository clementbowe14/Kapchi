import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminInventoryReader } from "./repository.js";

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
          userId: "clerk_admin"
        }
      : null;
  }
}));

const [{ default: adminBoundaryPlugin }, { createAdminInventoryPlugin }] = await Promise.all([
  import("../admin-auth/boundary.js"),
  import("./plugin.js")
]);

const fabric = {
  availabilityStatus: "available" as const,
  availableQuantity: 10,
  cartHeldQuantity: 1,
  colorHex: "#112233",
  colorName: "Navy",
  countedReservedQuantity: 2,
  createdAt: "2026-10-14T12:00:00.000Z",
  id: "9f6cb9ac-78f8-467d-81dd-ff287d4c5605",
  linkedListings: [],
  material: "Satin",
  name: "Navy Satin",
  orderReservedQuantity: 1,
  quantityOnHand: 12,
  quantitySold: 3,
  sku: "FAB-NAVY",
  status: "active" as const,
  storedReservedQuantity: 2,
  updatedAt: "2026-10-14T12:00:00.000Z"
};

function dependencies() {
  const report = {
    capabilities: {
      finishedProductInventory: {
        available: false as const,
        reason: "FINISHED_PRODUCT_LEDGER_UNAVAILABLE" as const
      },
      returnedUnitRestock: true,
      sharedFabricPools: true
    },
    filters: { lowStockThreshold: 5, stock: "all" as const },
    pools: [{ ...fabric, orderDrillDown: { fabricId: fabric.id } }],
    reconciliation: { expiredCount: 0, releasedQuantity: 0 },
    summary: {
      availableQuantity: 10,
      cartHeldQuantity: 1,
      lowStockPoolCount: 0,
      orderReservedQuantity: 1,
      outOfStockPoolCount: 0,
      poolCount: 1,
      quantityOnHand: 12,
      quantitySold: 3
    },
    untrackedProducts: []
  };
  const repository = {
    adjustStock: vi.fn(async () => ({ replayed: false, value: fabric })),
    createFabric: vi.fn(async () => ({ replayed: false, value: fabric })),
    linkListing: vi.fn(async () => ({ replayed: false, value: fabric })),
    list: vi.fn(async () => report),
    resolveActor: vi.fn(async (): Promise<{
      authSubject: string;
      userId: string;
    } | null> => ({
      authSubject: "clerk_admin",
      userId: "c33f2b22-2af9-4d03-b24b-f86e9b9b98a5"
    })),
    restockReturnedUnits: vi.fn(async () => ({ replayed: false, value: fabric })),
    updateFabric: vi.fn(async () => ({ replayed: false, value: fabric }))
  } satisfies AdminInventoryReader;
  return { report, repository };
}

async function server(repository: AdminInventoryReader) {
  const app = fastify({ logger: false });
  await app.register(adminBoundaryPlugin);
  await app.register(createAdminInventoryPlugin({ repository }), {
    prefix: "/admin/inventory"
  });
  return app;
}

describe("admin inventory plugin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns unique shared pools with configurable stock filters", async () => {
    const { report, repository } = dependencies();
    const app = await server(repository);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "GET",
      url: "/admin/inventory?stock=low&lowStockThreshold=8&search=navy"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
    expect(repository.list).toHaveBeenCalledWith({
      lowStockThreshold: 8,
      search: "navy",
      stock: "low"
    });
    await app.close();
  });

  it.each([
    { authorization: undefined, statusCode: 401 },
    { authorization: "Bearer customer-token", statusCode: 403 }
  ])("requires the exact admin role", async ({ authorization, statusCode }) => {
    const { repository } = dependencies();
    const app = await server(repository);
    const response = await app.inject({
      ...(authorization ? { headers: { authorization } } : {}),
      method: "GET",
      url: "/admin/inventory"
    });

    expect(response.statusCode).toBe(statusCode);
    expect(repository.list).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates inventory with a verified actor and durable idempotency key", async () => {
    const { repository } = dependencies();
    const app = await server(repository);
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "create-navy-fabric"
      },
      method: "POST",
      payload: {
        colorHex: "#112233",
        colorName: "Navy",
        material: "Satin",
        name: "Navy Satin",
        quantityOnHand: 12,
        sku: "FAB-NAVY"
      },
      url: "/admin/inventory/fabrics"
    });

    expect(response.statusCode).toBe(201);
    expect(repository.resolveActor).toHaveBeenCalledWith("clerk_admin");
    expect(repository.createFabric).toHaveBeenCalledWith(
      expect.objectContaining({ authSubject: "clerk_admin" }),
      expect.objectContaining({ sku: "FAB-NAVY" }),
      "create-navy-fabric",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    await app.close();
  });

  it("rejects mutations without an idempotency key", async () => {
    const { repository } = dependencies();
    const app = await server(repository);
    const response = await app.inject({
      headers: { authorization: "Bearer admin-token" },
      method: "POST",
      payload: { deltaOnHand: -1, reason: "Damaged unit" },
      url: `/admin/inventory/fabrics/${fabric.id}/adjustments`
    });

    expect(response.statusCode).toBe(400);
    expect(repository.adjustStock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a role-only admin without an active local audit actor", async () => {
    const { repository } = dependencies();
    repository.resolveActor.mockResolvedValueOnce(null);
    const app = await server(repository);
    const response = await app.inject({
      headers: {
        authorization: "Bearer admin-token",
        "idempotency-key": "adjust-navy"
      },
      method: "POST",
      payload: { deltaOnHand: 1, reason: "Count correction" },
      url: `/admin/inventory/fabrics/${fabric.id}/adjustments`
    });

    expect(response.statusCode).toBe(403);
    expect(repository.adjustStock).not.toHaveBeenCalled();
    await app.close();
  });
});
