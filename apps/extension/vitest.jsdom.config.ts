import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/extension-jsdom",
    include: [
      "src/content/page-image-selection.test.ts",
      "src/content/store-overlay.test.ts"
    ],
    passWithNoTests: true,
    environment: "jsdom",
    pool: "vmThreads",
    maxWorkers: 1,
    isolate: false,
    sequence: { groupOrder: 2 },
    testTimeout: 20_000,
    hookTimeout: 120_000
  }
});
