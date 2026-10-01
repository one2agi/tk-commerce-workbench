import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/web",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "src/components/settings/__tests__/**/*.{test,spec}.{ts,tsx}",
      "src/components/write-records/__tests__/**/*.{test,spec}.{ts,tsx}",
      "src/components/tasks/task-table.test.tsx",
      "src/app/tasks/page.test.tsx"
    ],
    passWithNoTests: true,
    environment: "node",
    pool: "forks"
  },
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  }
});
