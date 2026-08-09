import { defineConfig } from "vitest/config";

// Vitest 4 uses `test.projects`. Keeping the project list explicit prevents
// nested Git worktrees from being auto-discovered as duplicate test projects.
export default defineConfig({
  test: {
    projects: [
      "apps/web/vitest.config.ts",
      "apps/web/vitest.jsdom.config.ts",
      "apps/extension/vitest.config.ts",
      "apps/extension/vitest.jsdom.config.ts",
      "apps/worker/vitest.config.ts",
      "packages/contracts/vitest.config.ts",
      "packages/config/vitest.config.ts",
      "packages/db/vitest.config.ts",
      "packages/domain/vitest.config.ts",
      "packages/adapters/vitest.config.ts",
      {
        test: {
          name: "foundation",
          include: ["tests/foundation/**/*.{test,spec}.{ts,tsx}"],
          environment: "node"
        }
      }
    ]
  }
});
