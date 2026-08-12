import fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import listingsPlugin from "./plugin.js";

async function appWithQuery(query: ReturnType<typeof vi.fn>, prefix?: string) {
  const app = fastify({ logger: false });
  app.decorate("pg", { query } as unknown as Pool);
  if (prefix) {
    await app.register(listingsPlugin, { prefix });
  } else {
    await app.register(listingsPlugin);
  }
  return app;
}

describe("listings routes", () => {
  it("honors the production /listings registration prefix", async () => {
    const app = await appWithQuery(
      vi.fn().mockResolvedValue({ rows: [] }),
      "/listings",
    );
    const response = await app.inject({
      method: "GET",
      url: "/listings?type=graduation_stole"
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("validates the supported listing type", async () => {
    const app = await appWithQuery(vi.fn());
    const response = await app.inject({ method: "GET", url: "/?type=accessory" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    await app.close();
  });

  it("returns request identity with an empty public collection", async () => {
    const app = await appWithQuery(vi.fn().mockResolvedValue({ rows: [] }));
    const response = await app.inject({ method: "GET", url: "/?type=graduation_stole" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [] });
    expect(response.json().requestId).toEqual(expect.any(String));
    await app.close();
  });

  it("returns 404 without retrying a missing listing", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const app = await appWithQuery(query);
    const response = await app.inject({ method: "GET", url: "/missing-stole" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "LISTING_NOT_FOUND" });
    expect(query).toHaveBeenCalledOnce();
    await app.close();
  });

  it("maps permanent database failures to a safe 503 with Retry-After", async () => {
    const query = vi.fn().mockRejectedValue(
      Object.assign(new Error("private database detail"), { code: "42P01" }),
    );
    const app = await appWithQuery(query);
    const response = await app.inject({ method: "GET", url: "/?type=graduation_stole" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.body).not.toContain("private database detail");
    expect(query).toHaveBeenCalledOnce();
    await app.close();
  });
});
