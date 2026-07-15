import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/**/*.integration.{test,spec}.ts"],
    environment: "node",
    testTimeout: 30_000
  }
});
