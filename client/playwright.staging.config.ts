import { defineConfig, devices } from "@playwright/test";
import { readStagingPlaywrightSettings } from "./lib/staging-playwright";

const settings = readStagingPlaywrightSettings();
const desktopChrome = devices["Desktop Chrome"];

export default defineConfig({
  expect: {
    timeout: 10_000,
  },
  forbidOnly: true,
  fullyParallel: false,
  globalSetup: "./e2e/staging/staging-global-setup.ts",
  globalTeardown: "./e2e/staging/staging-global-teardown.ts",
  globalTimeout: 15 * 60_000,
  metadata: {
    apiOrigin: settings.apiOrigin,
    storefrontOrigin: settings.storefrontOrigin,
  },
  outputDir: "test-results/staging",
  projects: [
    {
      name: "guest",
      use: { ...desktopChrome },
    },
    {
      name: "customer",
      use: {
        ...desktopChrome,
        storageState: settings.storageState.customer,
      },
    },
    {
      name: "non-admin",
      use: {
        ...desktopChrome,
        storageState: settings.storageState.nonAdmin,
      },
    },
    {
      name: "admin",
      use: {
        ...desktopChrome,
        storageState: settings.storageState.admin,
      },
    },
  ],
  reporter: [
    [process.env.CI ? "line" : "list"],
    ["./e2e/staging/scenario-reporter.ts"],
  ],
  retries: 0,
  testDir: "./e2e",
  testMatch: /.*\.staging\.spec\.ts/,
  timeout: 45_000,
  use: {
    actionTimeout: 10_000,
    baseURL: settings.storefrontOrigin,
    navigationTimeout: 20_000,
    screenshot: "off",
    serviceWorkers: "block",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
