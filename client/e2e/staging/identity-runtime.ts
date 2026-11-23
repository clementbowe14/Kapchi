import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";
import {
  assertNoHarnessSecrets,
  scopedStagingBrowserHeaders,
  type StagingPlaywrightSettings,
} from "../../lib/staging-playwright";

type IdentityRole = "admin" | "customer" | "nonAdmin";
type StorageState = { cookies: unknown[]; origins: unknown[] };

export type StagingIdentity = {
  adminBinding?: { authSubject: string };
  externalId: string;
  role: IdentityRole;
  subject: string;
  type: "clerk-identity";
};

export type StagingIdentityManifest = {
  attemptId: string;
  identities: StagingIdentity[];
};

const CLERK_API_ORIGIN = "https://api.clerk.com";
const EXTERNAL_ID = /^kapchi-staging:intent_[0-9a-f]{32}$/;
const ROLES: IdentityRole[] = ["customer", "nonAdmin", "admin"];

async function clerkRequest(
  settings: StagingPlaywrightSettings,
  path: string,
  init: RequestInit,
  accepted: readonly number[],
  fetchImpl: typeof fetch,
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(`${CLERK_API_ORIGIN}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${settings.clerkSecretKey}`,
        ...init.headers,
      },
      redirect: "error",
    });
    if (accepted.includes(response.status)) return response;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`Clerk staging identity operation failed with HTTP ${response.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 100));
  }
  throw new Error("Clerk staging identity operation exhausted its retry budget.");
}

export async function loadStagingIdentityManifest(
  settings: StagingPlaywrightSettings,
): Promise<StagingIdentityManifest> {
  const value = JSON.parse(await readFile(settings.identityManifestPath, "utf8")) as unknown;
  if (!value || typeof value !== "object") throw new Error("Staging identity manifest is invalid.");
  const manifest = value as Partial<StagingIdentityManifest>;
  if (manifest.attemptId !== settings.attemptId || !Array.isArray(manifest.identities)) {
    throw new Error("Staging identity manifest belongs to another attempt or is malformed.");
  }
  assertNoHarnessSecrets(manifest, settings, "Staging identity manifest");
  const roles = manifest.identities.map(({ role }) => role);
  if (
    manifest.identities.length !== ROLES.length ||
    new Set(roles).size !== ROLES.length ||
    ROLES.some((role) => !roles.includes(role))
  ) {
    throw new Error("Staging identity manifest must contain exactly one reviewed identity per role.");
  }
  for (const identity of manifest.identities) {
    if (
      identity.type !== "clerk-identity" ||
      !EXTERNAL_ID.test(identity.externalId) ||
      !identity.subject ||
      (identity.role === "admin" && identity.adminBinding?.authSubject !== identity.subject) ||
      (identity.role !== "admin" && identity.adminBinding !== undefined)
    ) {
      throw new Error("Staging identity manifest contains foreign or incomplete ownership data.");
    }
  }
  return manifest as StagingIdentityManifest;
}

async function createStorageState(
  settings: StagingPlaywrightSettings,
  userId: string,
  fetchImpl: typeof fetch,
): Promise<StorageState> {
  const tokenResponse = await clerkRequest(settings, "/v1/sign_in_tokens", {
    body: JSON.stringify({ expires_in_seconds: 300, user_id: userId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }, [200, 201], fetchImpl);
  const tokenPayload = await tokenResponse.json() as { token?: string };
  if (!tokenPayload.token) throw new Error("Clerk did not return a staging sign-in token.");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      await route.continue({
        headers: scopedStagingBrowserHeaders(
          route.request().url(),
          route.request().headers(),
          settings,
        ),
      });
    });
    const page = await context.newPage();
    await page.goto(settings.storefrontOrigin);
    await page.waitForFunction(() => Boolean((window as typeof window & { Clerk?: { loaded?: boolean } }).Clerk?.loaded));
    await page.evaluate(async (ticket) => {
      const clerk = (window as typeof window & {
        Clerk?: {
          client: { signIn: { create(input: { strategy: "ticket"; ticket: string }): Promise<{ createdSessionId?: string; status?: string }> } };
          setActive(input: { session: string }): Promise<void>;
        };
      }).Clerk;
      if (!clerk) throw new Error("Clerk did not load in the staging storefront.");
      const signIn = await clerk.client.signIn.create({ strategy: "ticket", ticket });
      if (signIn.status !== "complete" || !signIn.createdSessionId) {
        throw new Error("Clerk staging sign-in did not complete.");
      }
      await clerk.setActive({ session: signIn.createdSessionId });
    }, tokenPayload.token);
    return await context.storageState();
  } finally {
    await browser.close();
  }
}

export async function setupStagingIdentities(
  settings: StagingPlaywrightSettings,
  fetchImpl: typeof fetch = fetch,
  storageStateFactory: typeof createStorageState = createStorageState,
) {
  await mkdir(dirname(settings.statePath), { mode: 0o700, recursive: true });
  try {
    const manifest = await loadStagingIdentityManifest(settings);
    for (const identity of manifest.identities) {
      const storageState = await storageStateFactory(settings, identity.subject, fetchImpl);
      assertNoHarnessSecrets(storageState, settings, "Playwright storage state");
      const path = settings.storageState[identity.role];
      await writeFile(path, JSON.stringify(storageState), { mode: 0o600 });
      await chmod(path, 0o600);
    }
    return {
      adminSubject: manifest.identities.find(({ role }) => role === "admin")!.subject,
    };
  } catch (error) {
    await rm(dirname(settings.statePath), { force: true, recursive: true });
    throw error;
  }
}

export async function teardownStagingIdentities(settings: StagingPlaywrightSettings) {
  await rm(dirname(settings.statePath), { force: true, recursive: true });
}
