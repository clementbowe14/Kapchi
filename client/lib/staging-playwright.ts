import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

type StagingEnvironment = Readonly<Record<string, string | undefined>>;

const ATTEMPT_ID = /^stg_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type StagingPlaywrightSettings = {
  apiOrigin: string;
  attemptId: string;
  bypassSecret: string;
  clerkSecretKey: string;
  identityManifestPath: string;
  resultsPath: string;
  siteDomain: string;
  statePath: string;
  storageState: {
    admin: string;
    customer: string;
    nonAdmin: string;
  };
  storefrontOrigin: string;
};

function required(environment: StagingEnvironment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for staging Playwright tests.`);
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace.`);
  }
  return value;
}

function requiredSecret(environment: StagingEnvironment, name: string): string {
  const value = required(environment, name);
  if (value.length < 16) throw new Error(`${name} must contain at least 16 characters.`);
  return value;
}

export function parseExactHttpsOrigin(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash || value !== parsed.origin
  ) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return parsed.origin;
}

export function parseSiteDomain(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== normalized || !DNS_NAME.test(normalized)) {
    throw new Error("E2E_STAGING_SITE_DOMAIN must be a lowercase registrable DNS name.");
  }
  return normalized;
}

function belongsToSite(origin: string, siteDomain: string) {
  const hostname = new URL(origin).hostname;
  return hostname === siteDomain || hostname.endsWith(`.${siteDomain}`);
}

export function assertDistinctSameSiteOrigins(
  storefrontOrigin: string,
  apiOrigin: string,
  siteDomain: string,
) {
  if (storefrontOrigin === apiOrigin) {
    throw new Error("Staging storefront and API origins must be distinct.");
  }
  if (!belongsToSite(storefrontOrigin, siteDomain) || !belongsToSite(apiOrigin, siteDomain)) {
    throw new Error("Staging storefront and API aliases must belong to E2E_STAGING_SITE_DOMAIN.");
  }
  const storefrontHost = new URL(storefrontOrigin).hostname;
  const apiHost = new URL(apiOrigin).hostname;
  if (
    storefrontHost.endsWith(`.${apiHost}`) ||
    apiHost.endsWith(`.${storefrontHost}`)
  ) {
    throw new Error("Staging storefront and API aliases must be sibling hosts.");
  }
}

function attemptDirectory(attemptId: string) {
  const digest = createHash("sha256").update(attemptId).digest("hex").slice(0, 16);
  return resolve(tmpdir(), `kapchi-staging-${digest}`);
}

export function storefrontBypassHeaders(
  requestUrl: string,
  settings: Pick<StagingPlaywrightSettings, "storefrontOrigin" | "bypassSecret">,
): Record<string, string> {
  if (new URL(requestUrl).origin !== settings.storefrontOrigin) return {};
  return {
    "x-vercel-protection-bypass": settings.bypassSecret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

export function scopedStagingBrowserHeaders(
  requestUrl: string,
  requestHeaders: Record<string, string>,
  settings: Pick<StagingPlaywrightSettings, "storefrontOrigin" | "bypassSecret">,
) {
  return {
    ...requestHeaders,
    ...storefrontBypassHeaders(requestUrl, settings),
  };
}

export function assertNoHarnessSecrets(
  value: unknown,
  settings: Pick<StagingPlaywrightSettings, "bypassSecret" | "clerkSecretKey">,
  label: string,
) {
  const serialized = JSON.stringify(value) ?? "";
  if (
    serialized.includes(settings.bypassSecret) ||
    serialized.includes(settings.clerkSecretKey) ||
    serialized.toLowerCase().includes("x-vercel-protection-bypass")
  ) {
    throw new Error(`${label} must not persist staging harness secrets.`);
  }
}

export function assertPublicApiResponse(response: Pick<Response, "status" | "headers">) {
  const vercelChallenge = response.headers.get("x-vercel-challenge-token")
    || response.headers.get("x-vercel-protection-bypass");
  const vercelHtmlChallenge = response.status === 401
    && response.headers.get("server")?.toLowerCase() === "vercel"
    && response.headers.get("content-type")?.toLowerCase().includes("text/html");
  if (vercelChallenge || vercelHtmlChallenge) {
    throw new Error(
      "The staging API is protected by Vercel. Keep the API public at Vercel and enforce authorization in Fastify.",
    );
  }
}

export function readStagingPlaywrightSettings(
  environment: StagingEnvironment = process.env,
  workingDirectory = process.cwd(),
): StagingPlaywrightSettings {
  const storefrontOrigin = parseExactHttpsOrigin(
    "E2E_STAGING_STOREFRONT_ORIGIN",
    required(environment, "E2E_STAGING_STOREFRONT_ORIGIN"),
  );
  const apiOrigin = parseExactHttpsOrigin(
    "E2E_STAGING_API_ORIGIN",
    required(environment, "E2E_STAGING_API_ORIGIN"),
  );
  const siteDomain = parseSiteDomain(required(environment, "E2E_STAGING_SITE_DOMAIN"));
  assertDistinctSameSiteOrigins(storefrontOrigin, apiOrigin, siteDomain);

  const attemptId = required(environment, "E2E_STAGING_ATTEMPT_ID");
  if (!ATTEMPT_ID.test(attemptId)) throw new Error("E2E_STAGING_ATTEMPT_ID is invalid.");
  const stateDirectory = attemptDirectory(attemptId);

  const clerkSecretKey = requiredSecret(environment, "CLERK_SECRET_KEY");
  if (!clerkSecretKey.startsWith("sk_test_")) {
    throw new Error("CLERK_SECRET_KEY must belong to a Clerk test instance.");
  }

  return {
    apiOrigin,
    attemptId,
    bypassSecret: requiredSecret(environment, "VERCEL_AUTOMATION_BYPASS_SECRET"),
    clerkSecretKey,
    identityManifestPath: resolve(
      workingDirectory,
      required(environment, "E2E_STAGING_IDENTITY_MANIFEST"),
    ),
    resultsPath: resolve(
      workingDirectory,
      environment.E2E_STAGING_SCENARIO_RESULTS ?? "test-results/staging/scenarios.ndjson",
    ),
    siteDomain,
    statePath: resolve(stateDirectory, "run-state.json"),
    storageState: {
      admin: resolve(stateDirectory, "admin.json"),
      customer: resolve(stateDirectory, "customer.json"),
      nonAdmin: resolve(stateDirectory, "non-admin.json"),
    },
    storefrontOrigin,
  };
}
