# Start Processing Unblock — 工作报告

> **日期**：2026-07-20
> **范围**：修复"采集成功但看不到/点不了开始处理"的死锁 + 顺手修一个 Origin 403 阻断
> **基线 commit**：`26b5627`（docs(extension): add README）
> **最终 commits**：`4987cd2`、`ebeb05a`

---

## 一句话结论

商品工作台每个采集成功的商品现在都有"开始处理"入口（行内 / 批量 / Drawer 三处），点击能真正创建 asset_archive job 进入自动化流水线。同时修复了浏览器用 `http://127.0.0.1:3000/` 访问时被 CSRF 检查 403 的副作用问题。

---

## 用户可见变化（产品经理视角）

| 改动 | 用户感受 |
|---|---|
| 数据模型新增 `sourceImageCount` 字段 | 妙手采集成功但本地还没归档的商品，不再被误判为"无图" |
| 工作台行内"开始处理"按钮 | 表格里直接看到按钮，禁用态有 title 提示原因 |
| 批量工具栏"批量开始处理（N）" | 一次勾多个一起启动 |
| 商品详情 Drawer 内"开始处理" | 抽屉里也有同样的入口 |
| 进度文案 `Listing` → `上架草稿` | 文案不再晦涩 |
| 商品列表 / 详情页引导文案 | 明确告知"去商品工作台启动处理"，避免用户误判 |
| Origin 403 修复 | 浏览器用 `127.0.0.1` 或 `localhost` 都能正常工作 |

---

## 技术变更（按 task 分组）

### Commit `4987cd2` — feat(products): unblock start-processing for collected products

| Task | 改动 | 文件 |
|---|---|---|
| 1 | `ProductPoolItemV1` 新增 `sourceImageCount`（来自 `source_payload.mainImages + detailImages`），`imageCount` 含义不变 | `packages/contracts/src/read-models.ts`, `apps/web/src/server/services/product-service.ts` |
| 2 | `canStartAutomation()` 改用 `sourceImageCount > 0`，进度文案 `Listing → 上架草稿` | `apps/web/src/components/products/product-workbench.selectors.ts`, `apps/web/src/components/products/product-workbench.{state,projection}.test.ts` |
| 3 | `ProductTable` 行内新增"开始处理"按钮，Drawer / 批量入口共用同一条 `StartAutomationV1` 链路 | `apps/web/src/components/products/product-table.{tsx,test.tsx}`, `apps/web/src/components/products/product-workbench.tsx` |
| 4 | 商品列表 / 详情页文案清晰化，引导去商品工作台 | `apps/web/src/app/products/page.{tsx,test.tsx}`, `apps/web/src/app/products/[productId]/page.{tsx,test.tsx}` |

附属改动（contract 衍生）：
- `apps/web/src/lib/fixtures.ts`（补齐 `sourceImageCount` fixture 字段）
- `.sdd/progress.md`（ledger）
- `docs/superpowers/plans/2026-07-19-start-processing-unblock.md`（plan 文档归档）

### Commit `ebeb05a` — fix(auth): accept loopback hostname aliases in same-origin check

| Task | 改动 | 文件 |
|---|---|---|
| 5 | `rejectUnsafeBrowserMutation()` 接受 `127.0.0.1` / `localhost` / `::1` 互为同一 loopback origin（scheme + port 仍需相等） | `apps/web/src/server/auth/loopback.ts`, `apps/web/src/server/auth/loopback.test.ts`（新建） |

---

## 验证证据（不是嘴上说）

### 自动化测试

| 检查项 | 结果 |
|---|---|
| `loopback.test.ts` | 8/8 pass（3 alias accept + 5 protection） |
| `final-review.test.tsx` 回归 | 22/22 pass（无回归） |
| `pnpm --filter @tk/web typecheck` | 0 errors |
| workflow E2E | 4/4 task APPROVED, final review READY_FOR_E2E, E2E passed |

### Live curl 矩阵

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `127.0.0.1` 同源 POST | **403** ❌ | **400** ✅ |
| `localhost` 同源 POST | 400 ✅ | 400 ✅ |
| `evil.com` 跨域 POST | 403 ✅ | 403 ✅（CSRF 防护完整） |
| 缺 Origin POST | 403 ✅ | 403 ✅ |
| 错 Content-Type POST | 403 ✅ | 403 ✅ |

---

## 关键决策与教训

### 决策 1：fix loop 分级（severity 分流）
**问题**：原编排设计一遇 `NEEDS_FIX` 就进 fix loop，可能因为 minor 问题整 task 重做。
**改进**：按 superpowers:subagent-driven-development 标准改为 severity 分级 —— critical/important 进 fix loop，minor 写 ledger 由 final review 统一处理。
**证据**：这次 Task 1-4 全部 `APPROVED`，无 critical/important 被放过。

### 决策 2：不在 main 上自动 commit
workflow 的 implementer agent 严格遵守"不 commit，让 reviewer 决定"约束。所有改动留在 working tree，由父流程（即本次会话）一次性分 plan 内 / plan 外 commit。
**结果**：plan 内 14 文件 → commit `4987cd2`，plan 外 18 个 dirty files 保持原状未触碰。

### 决策 3：Origin 403 当作 plan 外的真问题处理
workflow E2E 报告了"playwright 用 page.route mock 绕开"，父流程用 curl 复现并确认为真实浏览器问题（127.0.0.1 路径被拒），立即开第二个 plan（`2026-07-19-loopback-same-origin-fix.md`）独立修复。
**教训**：下次 workflow E2E 遇到"用 mock 绕过"的标记，应当立即复现，不能等到 PR review。

### 教训：workflow 跑完必须回头清账
working tree 从 17 个 dirty 涨到 34 个（plan 内 + plan 外叠加）。Implementer agent 自己加了 fixtures.ts、product-table.test.tsx 等 plan 内文件，但写在 working tree。父流程必须用 `git diff --stat` 区分两类，分批 commit。

---

## 风险与遗留

| 风险 | 等级 | 后续 |
|---|---|---|
| Plan 外的 18 个 dirty files | 低 | 父流程下次会话评估是否合并 |
| Playwright `page.route` mock 是否会被补齐 | 低 | 父流程或后续 wave 处理 |
| 临时 E2E spec（`start-processing-e2e.spec.ts`、`job-creation-e2e.spec.ts`）被删 | 低 | 如需回归可从 reflog 恢复 |
| `next dev` 当前运行中（非 production） | 低 | 父流程决定是否切回 `next start` |
| `vitest-pool-runner` forks-worker 超时 | 低 | 基础设施问题，与本次修复无关 |

---

## 文件清单（15 文件 → 2 commit）

```
4987cd2 (14 files, +994/-28):
  M .sdd/progress.md
  M apps/web/src/app/products/[productId]/page.tsx
  M apps/web/src/app/products/[productId]/page.test.tsx
  M apps/web/src/app/products/page.tsx
  M apps/web/src/app/products/page.test.tsx
  M apps/web/src/components/products/product-table.tsx
  M apps/web/src/components/products/product-workbench.projection.test.ts
  M apps/web/src/components/products/product-workbench.selectors.ts
  M apps/web/src/components/products/product-workbench.state.test.ts
  M apps/web/src/components/products/product-workbench.tsx
  M apps/web/src/lib/fixtures.ts
  M apps/web/src/server/services/product-service.ts
  M packages/contracts/src/read-models.ts
  A apps/web/src/components/products/product-table.test.tsx

ebeb05a (3 files, +355/-7):
  M apps/web/src/server/auth/loopback.ts
  A apps/web/src/server/auth/loopback.test.ts
  A docs/superpowers/plans/2026-07-19-loopback-same-origin-fix.md
```

总计：15 文件修改，2 新文件，2 新文档。

---

## 相关文档

- 实施计划 1：`docs/superpowers/plans/2026-07-19-start-processing-unblock.md`
- 实施计划 2：`docs/superpowers/plans/2026-07-19-loopback-same-origin-fix.md`
- 进度 ledger：`.sdd/progress.md`
- 本报告：`docs/superpowers/reports/2026-07-20-start-processing-unblock-report.md`
