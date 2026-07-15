import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/contracts",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
    environment: "node"
  }
});
