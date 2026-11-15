import { describe, expect, it } from "vitest";
import {
  parseExactHttpsOrigin,
  readStagingPlaywrightSettings,
} from "./staging-playwright";

const validEnvironment = {
  E2E_STAGING_ADMIN_STORAGE_STATE: ".auth/staging-admin.json",
  E2E_STAGING_API_ORIGIN: "https://api-staging.kapchi.example",
  E2E_STAGING_CUSTOMER_STORAGE_STATE: ".auth/staging-customer.json",
  E2E_STAGING_NON_ADMIN_STORAGE_STATE: ".auth/staging-non-admin.json",
  E2E_STAGING_STOREFRONT_ORIGIN: "https://staging.kapchi.example",
};

describe("staging Playwright settings", () => {
  it("accepts exact HTTPS origins and resolves runtime storage-state paths", () => {
    expect(readStagingPlaywrightSettings(validEnvironment, "/workspace/client")).toEqual({
      apiOrigin: "https://api-staging.kapchi.example",
      storageState: {
        admin: "/workspace/client/.auth/staging-admin.json",
        customer: "/workspace/client/.auth/staging-customer.json",
        nonAdmin: "/workspace/client/.auth/staging-non-admin.json",
      },
      storefrontOrigin: "https://staging.kapchi.example",
    });
  });

  it.each([
    "http://staging.kapchi.example",
    "https://staging.kapchi.example/",
    "https://staging.kapchi.example/path",
    "https://user:secret@staging.kapchi.example",
    "https://staging.kapchi.example?attempt=one",
    "https://staging.kapchi.example#release",
  ])("rejects a non-exact staging origin: %s", (origin) => {
    expect(() => parseExactHttpsOrigin("STAGING_ORIGIN", origin)).toThrow(
      "STAGING_ORIGIN must be an exact HTTPS origin.",
    );
  });

  it("rejects missing protected configuration", () => {
    expect(() =>
      readStagingPlaywrightSettings(
        {
          ...validEnvironment,
          E2E_STAGING_ADMIN_STORAGE_STATE: undefined,
        },
        "/workspace/client",
      ),
    ).toThrow(
      "E2E_STAGING_ADMIN_STORAGE_STATE is required for staging Playwright tests.",
    );
  });

  it("rejects a shared storefront and API origin", () => {
    expect(() =>
      readStagingPlaywrightSettings({
        ...validEnvironment,
        E2E_STAGING_API_ORIGIN: validEnvironment.E2E_STAGING_STOREFRONT_ORIGIN,
      }),
    ).toThrow("must be distinct");
  });

  it("rejects shared storage state between identities", () => {
    expect(() =>
      readStagingPlaywrightSettings({
        ...validEnvironment,
        E2E_STAGING_NON_ADMIN_STORAGE_STATE:
          validEnvironment.E2E_STAGING_CUSTOMER_STORAGE_STATE,
      }),
    ).toThrow("Each staging identity must use a distinct storage-state path.");
  });
});
