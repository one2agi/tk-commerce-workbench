import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/db",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{integration.test,integration.spec}.{ts,tsx}"
    ],
    passWithNoTests: true,
    environment: "node"
  }
});
