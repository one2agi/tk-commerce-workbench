import { defineWorkspace } from "vitest/config";

// 单元测试：所有包的 *.test.ts/tsx；foundation 作为基线。
// `pnpm test` 跑这些（不进入 integration project）。
// 注意：必须显式排除 .worktrees/，否则 Wave 1 子工作树里的同名源码会被重复扫描并失败。
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
      testTimeout: 30_000
    }
  }
], {
  // 全局排除 Wave 1/2/3/4 工作树中的源码，避免在 Gate 合并关卡误扫描。
  exclude: [".worktrees/**", ".superpowers/**"]
});

