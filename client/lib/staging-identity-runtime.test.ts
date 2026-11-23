import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadStagingIdentityManifest,
  setupStagingIdentities,
  teardownStagingIdentities,
  type StagingIdentityManifest,
} from "../e2e/staging/identity-runtime";
import { readStagingPlaywrightSettings } from "./staging-playwright";

const settings = readStagingPlaywrightSettings({
  CLERK_SECRET_KEY: "sk_test_identity-control-secret-123",
  E2E_STAGING_API_ORIGIN: "https://api.staging.kapchi.example",
  E2E_STAGING_ATTEMPT_ID: "stg_identity_12345678",
  E2E_STAGING_IDENTITY_MANIFEST: "/tmp/kapchi-staging-identity-manifest.json",
  E2E_STAGING_SITE_DOMAIN: "staging.kapchi.example",
  E2E_STAGING_STOREFRONT_ORIGIN: "https://shop.staging.kapchi.example",
  VERCEL_AUTOMATION_BYPASS_SECRET: "vercel-bypass-secret-123",
});

function identityManifest(overrides: Partial<StagingIdentityManifest> = {}): StagingIdentityManifest {
  return {
    attemptId: settings.attemptId,
    identities: [
      {
        externalId: `kapchi-staging:intent_${"1".repeat(32)}`,
        role: "customer",
        subject: "user_customer",
        type: "clerk-identity",
      },
      {
        externalId: `kapchi-staging:intent_${"2".repeat(32)}`,
        role: "nonAdmin",
        subject: "user_non_admin",
        type: "clerk-identity",
      },
      {
        adminBinding: { authSubject: "user_admin" },
        externalId: `kapchi-staging:intent_${"3".repeat(32)}`,
        role: "admin",
        subject: "user_admin",
        type: "clerk-identity",
      },
    ],
    ...overrides,
  };
}

async function writeManifest(manifest = identityManifest()) {
  await mkdir(dirname(settings.identityManifestPath), { recursive: true });
  await writeFile(settings.identityManifestPath, JSON.stringify(manifest), { mode: 0o600 });
}

afterEach(async () => {
  await rm(dirname(settings.statePath), { force: true, recursive: true });
  await rm(settings.identityManifestPath, { force: true });
});

describe("staging Clerk identity runtime", () => {
  it("consumes adapter-provisioned identities without creating or deleting Clerk users", async () => {
    await writeManifest();
    const fetchMock = vi.fn(async () => {
      throw new Error("browser setup must not mutate Clerk users");
    }) as unknown as typeof fetch;
    const storageStateFactory = vi.fn(async (
      ...args: [typeof settings, string, typeof fetch]
    ) => {
      void args;
      return { cookies: [], origins: [] };
    });

    await expect(setupStagingIdentities(settings, fetchMock, storageStateFactory)).resolves.toEqual({
      adminSubject: "user_admin",
    });

    expect(storageStateFactory.mock.calls.map(([, subject]) => subject)).toEqual([
      "user_customer",
      "user_non_admin",
      "user_admin",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(access(settings.storageState.admin)).resolves.toBeUndefined();
    await teardownStagingIdentities(settings);
    await expect(access(settings.storageState.admin)).rejects.toThrow();
  });

  it("rejects foreign attempts, duplicate roles, and incomplete admin bindings", async () => {
    await writeManifest(identityManifest({ attemptId: "stg_foreign_12345678" }));
    await expect(loadStagingIdentityManifest(settings)).rejects.toThrow("another attempt");

    const duplicate = identityManifest();
    duplicate.identities[1] = { ...duplicate.identities[0]! };
    await writeManifest(duplicate);
    await expect(loadStagingIdentityManifest(settings)).rejects.toThrow("exactly one reviewed identity");

    const missingBinding = identityManifest();
    delete missingBinding.identities[2]!.adminBinding;
    await writeManifest(missingBinding);
    await expect(loadStagingIdentityManifest(settings)).rejects.toThrow("incomplete ownership");
  });

  it("refuses to persist harness secrets and removes partial browser state", async () => {
    await writeManifest();
    const unsafeStorageState = vi.fn(async () => ({
      cookies: [{ name: "session", value: settings.bypassSecret }],
      origins: [],
    }));
    await expect(
      setupStagingIdentities(settings, vi.fn() as unknown as typeof fetch, unsafeStorageState),
    ).rejects.toThrow("must not persist staging harness secrets");
    await expect(access(settings.storageState.customer)).rejects.toThrow();
  });
});
