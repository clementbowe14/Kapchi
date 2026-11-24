import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { GET, resolveStorefrontReleaseIdentity } from "./route";

describe("storefront release identity", () => {
  it("prefers explicit release values over Vercel system fallbacks", () => {
    expect(
      resolveStorefrontReleaseIdentity({
        KAPCHI_ENVIRONMENT: "staging",
        NODE_ENV: "production",
        RELEASE_DEPLOYMENT_ID: "dpl_explicit",
        RELEASE_ENVIRONMENT_IDENTITY_MARKER: "marker-value-with-at-least-thirty-two-bytes",
        RELEASE_SCENARIO_REGISTRY_VERSION: "2026-11-24.1",
        RELEASE_SHA: "a".repeat(40),
        VERCEL_DEPLOYMENT_ID: "dpl_system",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
      }),
    ).toEqual({
      environment: "staging",
      environmentIdentity: createHash("sha256")
        .update("kapchi-deployment-identity:v1:marker-value-with-at-least-thirty-two-bytes")
        .digest("hex"),
      releaseDeploymentId: "dpl_explicit",
      registryVersion: "2026-11-24.1",
      releaseSha: "a".repeat(40),
    });
  });

  it("uses Vercel system values when explicit release values are absent", () => {
    expect(
      resolveStorefrontReleaseIdentity({
        NODE_ENV: "production",
        VERCEL_DEPLOYMENT_ID: "dpl_system",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
      }),
    ).toEqual({
      environment: "preview",
      environmentIdentity: "unconfigured",
      releaseDeploymentId: "dpl_system",
      registryVersion: "unconfigured",
      releaseSha: "b".repeat(40),
    });
  });

  it("returns only customer-safe release fields without caching", async () => {
    const response = GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "environment",
      "environmentIdentity",
      "registryVersion",
      "releaseDeploymentId",
      "releaseSha",
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
