import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/db",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{integration.test,integration.spec}.{ts,tsx}"
    ],
    passWithNoTests: true,
    environment: "node",
    // 集成测试需要后端 Postgres; testTimeout 放宽。
    testTimeout: 30_000
  }
});
