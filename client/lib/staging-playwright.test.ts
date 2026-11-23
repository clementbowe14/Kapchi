import { describe, expect, it } from "vitest";
import {
  assertNoHarnessSecrets,
  assertDistinctSameSiteOrigins,
  assertPublicApiResponse,
  parseExactHttpsOrigin,
  readStagingPlaywrightSettings,
  scopedStagingBrowserHeaders,
  storefrontBypassHeaders,
} from "./staging-playwright";

const validEnvironment = {
  E2E_STAGING_API_ORIGIN: "https://api.staging.kapchi.example",
  E2E_STAGING_ATTEMPT_ID: "stg_attempt_12345678",
  E2E_STAGING_IDENTITY_MANIFEST: "test-results/staging/identities.json",
  CLERK_SECRET_KEY: "sk_test_identity-control-secret-123",
  E2E_STAGING_SITE_DOMAIN: "staging.kapchi.example",
  E2E_STAGING_STOREFRONT_ORIGIN: "https://shop.staging.kapchi.example",
  VERCEL_AUTOMATION_BYPASS_SECRET: "vercel-bypass-secret-123",
};

describe("staging Playwright settings", () => {
  it("accepts distinct exact HTTPS aliases under an explicit site domain", () => {
    const settings = readStagingPlaywrightSettings(validEnvironment, "/workspace/client");
    expect(settings.apiOrigin).toBe("https://api.staging.kapchi.example");
    expect(settings.storefrontOrigin).toBe("https://shop.staging.kapchi.example");
    expect(settings.storageState.admin).toContain("kapchi-staging-");
    expect(settings.storageState.admin).not.toContain("/workspace/client");
  });

  it.each([
    "http://shop.staging.kapchi.example",
    "https://shop.staging.kapchi.example/",
    "https://shop.staging.kapchi.example/path",
    "https://user:secret@shop.staging.kapchi.example",
    "https://shop.staging.kapchi.example?attempt=one",
  ])("rejects a non-exact staging origin: %s", (origin) => {
    expect(() => parseExactHttpsOrigin("STAGING_ORIGIN", origin)).toThrow("exact HTTPS origin");
  });

  it("rejects different sites and identical aliases", () => {
    expect(() => assertDistinctSameSiteOrigins(
      "https://shop.staging.kapchi.example",
      "https://api.other.example",
      "staging.kapchi.example",
    )).toThrow("must belong");
    expect(() => assertDistinctSameSiteOrigins(
      "https://shop.staging.kapchi.example",
      "https://shop.staging.kapchi.example",
      "staging.kapchi.example",
    )).toThrow("must be distinct");
    expect(() => assertDistinctSameSiteOrigins(
      "https://shop.staging.kapchi.example",
      "https://api.shop.staging.kapchi.example",
      "staging.kapchi.example",
    )).toThrow("sibling hosts");
  });

  it("sends the Vercel bypass only to the exact storefront origin", () => {
    const settings = readStagingPlaywrightSettings(validEnvironment);
    expect(storefrontBypassHeaders(`${settings.storefrontOrigin}/cart`, settings)).toEqual({
      "x-vercel-protection-bypass": validEnvironment.VERCEL_AUTOMATION_BYPASS_SECRET,
      "x-vercel-set-bypass-cookie": "true",
    });
    expect(storefrontBypassHeaders(`${settings.apiOrigin}/cart`, settings)).toEqual({});
    expect(storefrontBypassHeaders("https://evil.example/cart", settings)).toEqual({});
    expect(scopedStagingBrowserHeaders(
      "https://clerk.staging.example/v1/client",
      { accept: "application/json" },
      settings,
    )).toEqual({ accept: "application/json" });
    expect(scopedStagingBrowserHeaders(
      `${settings.storefrontOrigin}/sign-in`,
      { accept: "text/html" },
      settings,
    )).toEqual({
      accept: "text/html",
      "x-vercel-protection-bypass": validEnvironment.VERCEL_AUTOMATION_BYPASS_SECRET,
      "x-vercel-set-bypass-cookie": "true",
    });
  });

  it("rejects harness secrets in persisted state and reports", () => {
    const settings = readStagingPlaywrightSettings(validEnvironment);
    expect(() => assertNoHarnessSecrets(
      { cookies: [{ name: "session", value: settings.bypassSecret }] },
      settings,
      "storage state",
    )).toThrow("must not persist");
    expect(() => assertNoHarnessSecrets(
      { message: settings.clerkSecretKey },
      settings,
      "report",
    )).toThrow("must not persist");
    expect(() => assertNoHarnessSecrets({ status: "pass" }, settings, "report")).not.toThrow();
  });

  it("rejects a Vercel-protected API response", () => {
    expect(() => assertPublicApiResponse(new Response(null, {
      headers: { "content-type": "text/html", server: "Vercel" },
      status: 401,
    }))).toThrow("Keep the API public at Vercel");
  });

  it("rejects missing secrets and malformed attempts", () => {
    expect(() => readStagingPlaywrightSettings({
      ...validEnvironment,
      E2E_STAGING_ATTEMPT_ID: "bad",
    })).toThrow("ATTEMPT_ID is invalid");
    expect(() => readStagingPlaywrightSettings({
      ...validEnvironment,
      VERCEL_AUTOMATION_BYPASS_SECRET: "short",
    })).toThrow("at least 16 characters");
  });
});
