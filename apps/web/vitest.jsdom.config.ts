import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tk/adapters": fileURLToPath(new URL("../../packages/adapters/src/index.ts", import.meta.url))
    }
  },
  test: {
    name: "@tk/web-jsdom",
    include: [
      "src/components/settings/__tests__/**/*.{test,spec}.{ts,tsx}",
      "src/components/tasks/task-table.test.tsx",
      "src/app/tasks/page.test.tsx"
    ],
    passWithNoTests: true,
    environment: "jsdom",
    pool: "vmThreads",
    maxWorkers: 1,
    isolate: false,
    sequence: { groupOrder: 1 },
    setupFiles: ["./src/test/setup-jsdom.ts"]
  },
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  }
});
