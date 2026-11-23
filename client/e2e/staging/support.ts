import { appendFile, readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";
import {
  assertNoHarnessSecrets,
  assertPublicApiResponse,
  readStagingPlaywrightSettings,
  scopedStagingBrowserHeaders,
} from "../../lib/staging-playwright";

export type StagingFixtureManifest = {
  attemptId: string;
  assets: {
    adminArtworkPath: string;
    forbiddenArtworkPath: string;
    uploadIntentBody: Record<string, unknown>;
  };
  cartItems: Record<
    "none" | "shortText" | "longText" | "textImage" | "textImageTrim",
    {
      expected: {
        customizationSummary: Record<string, unknown>;
        forbiddenOverrides: Array<Record<string, unknown>>;
        unitAmountCents: number;
      };
      request: Record<string, unknown>;
    }
  >;
  checkout: {
    contact: Record<string, unknown>;
  };
  orders: {
    adminOrderId: string;
    adminTransitionBody: Record<string, unknown>;
    customerLookup: Record<string, unknown>;
    refunds: Array<{ body: Record<string, unknown>; orderId: string }>;
    shipmentBody: Record<string, unknown>;
  };
};

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    /secret|password|private.?key|access.?token/i.test(key) || containsForbiddenKey(entry),
  );
}

export async function loadStagingFixtureManifest(
  path = process.env.E2E_STAGING_FIXTURE_MANIFEST,
): Promise<StagingFixtureManifest> {
  if (!path) throw new Error("E2E_STAGING_FIXTURE_MANIFEST is required.");
  const manifest = JSON.parse(await readFile(path, "utf8")) as StagingFixtureManifest;
  const attemptId = readStagingPlaywrightSettings().attemptId;
  if (manifest.attemptId !== attemptId) {
    throw new Error("Fixture manifest belongs to another staging attempt.");
  }
  if (containsForbiddenKey(manifest)) {
    throw new Error("Fixture manifest must not contain credentials.");
  }
  assertNoHarnessSecrets(manifest, readStagingPlaywrightSettings(), "Fixture manifest");
  return manifest;
}

type ApiResult = {
  body: unknown;
  headers: Headers;
  status: number;
};

export async function browserApi(
  page: Page,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<ApiResult> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("API path must be root-relative.");
  const settings = readStagingPlaywrightSettings();
  const result = await page.evaluate(async ({ apiOrigin, path, options }) => {
    const clerk = (window as typeof window & {
      Clerk?: { session?: { getToken(): Promise<string | null> } };
    }).Clerk;
    const authToken = await clerk?.session?.getToken() ?? null;
    const response = await fetch(`${apiOrigin}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...options.headers,
      },
      method: options.method ?? "GET",
      redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return {
      body,
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
    };
  }, { apiOrigin: settings.apiOrigin, options, path });
  const response = new Response(null, { headers: result.headers, status: result.status });
  assertPublicApiResponse(response);
  if (result.status >= 300 && result.status < 400) {
    throw new Error("The staging API must not redirect browser API calls.");
  }
  return { ...result, headers: response.headers };
}

export const test = base.extend<{ manifest: StagingFixtureManifest }>({
  context: async ({ context }, provide) => {
    const settings = readStagingPlaywrightSettings();
    await context.route("**/*", async (route) => {
      await route.continue({
        headers: scopedStagingBrowserHeaders(
          route.request().url(),
          route.request().headers(),
          settings,
        ),
      });
    });
    await provide(context);
  },
  manifest: async ({}, provide) => {
    await provide(await loadStagingFixtureManifest());
  },
});

export async function appendScenarioObservation(
  observation: {
    assertionIds: string[];
    attemptId: string;
    candidateSha: string;
    finishedAt: string;
    observationVersion: 1;
    outcome: "failed" | "passed" | "skipped";
    scenarioId: string;
    startedAt: string;
    testId: string;
  },
) {
  const settings = readStagingPlaywrightSettings();
  assertNoHarnessSecrets(observation, settings, "Scenario observation");
  await appendFile(settings.resultsPath, `${JSON.stringify(observation)}\n`, { encoding: "utf8" });
}

export async function waitForCorrelationEvidence(
  correlationId: string,
  sensitiveProbe: string,
  options: { intervalMs?: number; path?: string; timeoutMs?: number } = {},
) {
  const path = options.path ?? process.env.E2E_STAGING_LOG_EVIDENCE_PATH;
  if (!path) throw new Error("E2E_STAGING_LOG_EVIDENCE_PATH is required for observability proof.");
  if (!/^staging-[A-Za-z0-9-]{12,96}$/.test(correlationId)) {
    throw new Error("Observability correlation ID is invalid.");
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  do {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content.includes(sensitiveProbe)) {
      throw new Error("Captured staging logs contain the sensitive observability probe.");
    }
    const entries = content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const match = entries.find((entry) =>
      (entry.requestId === correlationId || entry.correlationId === correlationId) &&
      entry.event === "http.request.completed" &&
      entry.statusCode === 200,
    );
    if (match) return match;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
  } while (Date.now() <= deadline);
  throw new Error("Captured staging logs did not prove request correlation before the deadline.");
}

export { expect };
