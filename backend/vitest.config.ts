import { defineConfig } from "vitest/config";

const databaseIntegrationTestsEnabled =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";

export default defineConfig({
  test: {
    fileParallelism: !databaseIntegrationTestsEnabled,
    include: ["src/**/*.test.ts"]
  }
});
