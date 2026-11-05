import { defineConfig, devices } from "@playwright/test";

const storageState = process.env.E2E_ADMIN_STORAGE_STATE ?? ".auth/admin.json";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    env: {
      ...process.env,
      // Browser E2E tests mock this same-origin surface; production uses the
      // explicit Fastify origin configured by the deployment environment.
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3100/api",
    },
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "public-desktop",
      testMatch: /.*\.public\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "admin-desktop",
      testMatch: /.*\.admin\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState },
    },
    {
      name: "admin-mobile",
      testMatch: /.*\.admin\.spec\.ts/,
      use: { ...devices["iPhone 13"], browserName: "chromium", storageState },
    },
  ],
});
