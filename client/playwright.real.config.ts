import { defineConfig, devices } from "@playwright/test";

const storageState = process.env.E2E_ADMIN_STORAGE_STATE ?? ".auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.real\.spec\.ts/,
  fullyParallel: false,
  globalSetup: "./e2e/real-global-setup.ts",
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3100",
    screenshot: "off",
    storageState,
    trace: "off",
    video: "off",
  },
  webServer: [
    {
      command: "npm run dev",
      cwd: "../backend",
      port: 4000,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      port: 3100,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
