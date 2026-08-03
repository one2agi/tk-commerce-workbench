import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/extension",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "src/content/page-image-selection.test.ts",
      "src/content/store-overlay.test.ts"
    ],
    passWithNoTests: true,
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 120_000
  }
});
