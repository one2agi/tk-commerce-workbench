import { defineConfig } from "@playwright/test";

const loopbackNoProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",");
process.env.NO_PROXY = loopbackNoProxy;
process.env.no_proxy = loopbackNoProxy;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Database-backed scenarios reset shared fixtures and must remain deterministic.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1366, height: 768 }
  },
  webServer: {
    command: "DATABASE_URL=$TEST_DATABASE_URL pnpm db:migrate && DATABASE_URL=$TEST_DATABASE_URL PORT=3100 pnpm --filter @tk/web start",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 180_000
  }
});
