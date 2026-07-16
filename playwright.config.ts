import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Database-backed scenarios reset shared fixtures and must remain deterministic.
  fullyParallel: false,
  workers: 1
});
