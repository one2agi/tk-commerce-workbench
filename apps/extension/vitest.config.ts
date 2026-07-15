import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/extension",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
    environment: "jsdom",
    globals: false
  }
});
