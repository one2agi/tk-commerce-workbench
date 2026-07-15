import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/worker",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "src/**/*.integration.test.ts"],
    exclude: ["src/**/*.pg.test.ts"],
    passWithNoTests: true,
    environment: "node"
  }
});
