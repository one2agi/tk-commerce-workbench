import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@tk/worker-integration",
    include: ["src/**/*.pg.test.ts"],
    environment: "node",
    fileParallelism: false
  }
});
