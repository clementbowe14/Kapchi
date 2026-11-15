import { resolve } from "node:path";

type StagingEnvironment = Readonly<Record<string, string | undefined>>;

export type StagingPlaywrightSettings = {
  apiOrigin: string;
  storageState: {
    admin: string;
    customer: string;
    nonAdmin: string;
  };
  storefrontOrigin: string;
};

function required(environment: StagingEnvironment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required for staging Playwright tests.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace.`);
  }
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
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }

  return parsed.origin;
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

  if (storefrontOrigin === apiOrigin) {
    throw new Error(
      "E2E_STAGING_STOREFRONT_ORIGIN and E2E_STAGING_API_ORIGIN must be distinct.",
    );
  }

  const storageState = {
    admin: resolve(
      workingDirectory,
      required(environment, "E2E_STAGING_ADMIN_STORAGE_STATE"),
    ),
    customer: resolve(
      workingDirectory,
      required(environment, "E2E_STAGING_CUSTOMER_STORAGE_STATE"),
    ),
    nonAdmin: resolve(
      workingDirectory,
      required(environment, "E2E_STAGING_NON_ADMIN_STORAGE_STATE"),
    ),
  };

  if (new Set(Object.values(storageState)).size !== 3) {
    throw new Error("Each staging identity must use a distinct storage-state path.");
  }

  return {
    apiOrigin,
    storageState,
    storefrontOrigin,
  };
}
