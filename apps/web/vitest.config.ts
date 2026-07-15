import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/web",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
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