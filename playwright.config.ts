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
    command: "pnpm db:migrate && pnpm --filter @tk/web start",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      LOCAL_OPERATOR_ID: process.env.LOCAL_OPERATOR_ID ?? "playwright-e2e-operator",
      EXTENSION_TOKEN: process.env.EXTENSION_TOKEN ?? "playwright-e2e-extension-token",
      CONFIG_ENCRYPTION_KEY: process.env.CONFIG_ENCRYPTION_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ALLOW_LAN: "false",
      EXTERNAL_ADAPTER_MODE: "mock",
      ASSET_ROOT: process.env.ASSET_ROOT ?? "./data/e2e-assets",
      IMAGE_GENERATION_PATH: process.env.IMAGE_GENERATION_PATH ?? "headless",
      PORT: "3100",
      NO_PROXY: loopbackNoProxy,
      no_proxy: loopbackNoProxy
    }
  }
});
