import { defineWorkspace } from "vitest/config";

// 单元测试：所有包的 *.test.ts/tsx；foundation 作为基线。
// `pnpm test` 跑这些（不进入 integration project）。
export default defineWorkspace([
  "tests/foundation/**/*.test.ts",
  "apps/web/src/**/*.{test,spec}.{ts,tsx}",
  "apps/extension/src/**/*.{test,spec}.{ts,tsx}",
  "apps/worker/src/**/*.{test,spec}.ts",
  "packages/contracts/src/**/*.{test,spec}.ts",
  "packages/config/src/**/*.{test,spec}.ts",
  "packages/domain/src/**/*.{test,spec}.ts",
  "packages/adapters/src/**/*.{test,spec}.ts",
  {
    extends: true,
    test: {
      name: "integration",
      include: [
        "packages/db/src/**/*.{integration.test,integration.spec}.ts",
        "apps/worker/src/**/*.{integration.test,integration.spec}.ts",
        "tests/integration/**/*.{test,spec}.ts"
      ],
      environment: "node",
      // 明确把慢集成测试与默认 test 流程隔离。
      testTimeout: 30_000
    }
  }
]);
