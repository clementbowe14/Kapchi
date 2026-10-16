import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth/index.js", () => ({
  authMiddleware: async () => undefined
}));

const [{ default: adminBoundaryPlugin }, { adminRoute }] = await Promise.all([
  import("./boundary.js"),
  import("./guards.js")
]);

describe("admin route boundary", () => {
  it("rejects an admin route that does not declare a capability", async () => {
    const app = fastify({ logger: false });
    await app.register(adminBoundaryPlugin);

    expect(() => {
      app.get("/admin/unprotected", async () => ({ ok: true }));
    }).toThrow("missing its admin capability guard");
    await app.close();
  });

  it("rejects capability metadata without the actual guard", async () => {
    const app = fastify({ logger: false });
    await app.register(adminBoundaryPlugin);

    expect(() => {
      app.get(
        "/admin/metadata-only",
        { config: { adminCapability: "customers:read" } },
        async () => ({ ok: true }),
      );
    }).toThrow("missing its admin capability guard");
    await app.close();
  });

  it("accepts a prefixed route carrying the shared capability guard", async () => {
    const app = fastify({ logger: false });
    await app.register(adminBoundaryPlugin);
    await app.register(
      async (scope) => {
        scope.get(
          "/protected",
          adminRoute("customers:read"),
          async () => ({ ok: true }),
        );
      },
      { prefix: "/admin/customers" },
    );

    await app.ready();
    await app.close();
  });
});
