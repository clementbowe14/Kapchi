import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifyClerkToken: vi.fn() }));
vi.mock("../auth/jwt.js", () => ({ verifyClerkToken: mocks.verifyClerkToken }));

const [{ authPlugin }, { adminRoute }] = await Promise.all([
  import("../auth/index.js"),
  import("./index.js")
]);

async function build() {
  const app = fastify({ logger: false });
  await app.register(authPlugin);
  app.get("/admin/probe", adminRoute("orders:read"), async () => ({ ok: true }));
  return app;
}

function authenticated({
  permissions = [],
  roles = []
}: {
  permissions?: string[];
  roles?: string[];
}) {
  mocks.verifyClerkToken.mockResolvedValue({
    claims: {},
    permissions,
    roles,
    sessionId: "session_123",
    token: "verified-token",
    userId: "user_123"
  });
}

describe("admin capability guard", () => {
  beforeEach(() => mocks.verifyClerkToken.mockReset());

  it("returns a structured 401 when authentication is missing", async () => {
    const app = await build();
    const response = await app.inject({ method: "GET", url: "/admin/probe" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      requestId: expect.any(String),
      statusCode: 401
    });
    await app.close();
  });

  it("returns 401 instead of 500 for invalid or expired tokens", async () => {
    mocks.verifyClerkToken.mockRejectedValueOnce(
      Object.assign(new Error("expired secret-bearing token"), {
        code: "ERR_JWT_EXPIRED"
      }),
    );
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer expired-token" },
      method: "GET",
      url: "/admin/probe"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: "Bearer token is invalid or expired.",
      requestId: expect.any(String)
    });
    expect(response.body).not.toContain("secret-bearing");
    await app.close();
  });

  it("rejects malformed authorization instead of treating it as a guest", async () => {
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Basic browser-supplied-value" },
      method: "GET",
      url: "/admin/probe"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "UNAUTHORIZED",
      message: "Authorization must use a valid Bearer token."
    });
    expect(mocks.verifyClerkToken).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    { label: "customer", permissions: [], roles: ["customer"] },
    {
      label: "organization admin only",
      permissions: ["org:admin"],
      roles: ["org:admin"]
    },
    {
      label: "permission-only principal",
      permissions: ["orders:read", "orders:refund", "assets:write"],
      roles: []
    }
  ])("returns 403 for a $label", async ({ permissions, roles }) => {
    authenticated({ permissions, roles });
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/admin/probe"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "FORBIDDEN",
      requestId: expect.any(String),
      statusCode: 403
    });
    await app.close();
  });

  it("allows the exact verified store admin role", async () => {
    authenticated({ roles: ["admin"] });
    const app = await build();
    const response = await app.inject({
      headers: { authorization: "Bearer verified-token" },
      method: "GET",
      url: "/admin/probe"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
