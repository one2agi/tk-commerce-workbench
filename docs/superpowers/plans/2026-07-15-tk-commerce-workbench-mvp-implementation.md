# TK Commerce Workbench MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库交付一个本地单用户工作台，完成“1688 勾选链接 → 妙手公共采集箱 → 本地商品池 → 人工开始自动处理 → Canvas `TK工作流` → 人工确认 → 编辑同一条妙手公共采集箱商品”的可恢复 MVP。

**Architecture:** 使用 pnpm workspace 管理的模块化 TypeScript Monorepo。Next.js Web 只处理交互和短请求，PostgreSQL 保存商品修订、任务和审批，独立 Worker 使用租约执行长任务；外部系统全部通过版本化 Adapter Port 接入。本计划以一个主协调 Agent 和最多三个开发 Agent 执行，每一波从同一集成提交创建三个独立 Git 工作树，波次结束后先评审再合流。

**Tech Stack:** Node.js 22 LTS、Corepack + pnpm 9.15.9、TypeScript 5、Next.js 16 App Router、React 19、PostgreSQL 16、Drizzle ORM 0.45、Vitest、Playwright、Manifest V3、Docker Compose。

## Global Constraints

- 运行时固定 Node.js 22 LTS；仓库 `packageManager` 固定 `pnpm@9.15.9`，所有 Agent 使用同一 `pnpm-lock.yaml`。
- MVP 为本地单用户，不实现注册、登录、角色或多租户；启动时确保固定本地操作员存在。
- Web 与 Worker 是不同进程；HTTP 请求只查询状态或创建任务，不执行下载、LLM、Canvas 轮询或妙手同步。
- 扩展只提交用户在 1688 店铺预览中勾选的链接，不解析完整详情页，不支持无确认的全店采集。
- 妙手 `fetch_item` 是 1688 主采集器；重复 `skip` 必须按 `sourceItemId` 解析并复用已有 `success` 详情。
- 商品采集后停留在 `automation.not_started`；点击“开始处理”前禁止调用 LLM、汇率和 Canvas。
- Canvas 输入容量必须在每次运行前读取；当前九槽不是固定合同，不用重复图补满；预期五张输出，1–4 张为 `partial`，零张为 `failed`。
- 本地文件系统是永久素材事实来源，外部 URL 只用于妙手或 Canvas 临时中转。
- 最终操作只编辑同一条 canonical 妙手公共采集箱详情；MVP 禁止认领、TikTok 采集箱编辑和自动发布。
- 金额、重量、尺寸始终携带币种或单位；领域层不使用无单位 `number` 表示业务量。
- 外部密钥不得进入仓库、数据库日志或测试 fixture；配置只显示“是否已配置”。
- 每个功能使用 TDD：先提交可复现的失败测试，再写最小实现，通过局部测试后才能提交。

---

## 1. Parallel Execution Model

### 1.1 Branches, worktrees, and ownership

主协调 Agent 独占集成分支、根配置、锁文件、跨系统 E2E 和文档。每个并行波次创建新工作树，不跨波次复用旧工作树：

| 泳道 | 工作树示例 | 独占文件范围 | 业务职责 |
|---|---|---|---|
| Edge | `.worktrees/w1-edge` | `apps/extension/**`, `packages/adapters/**`, `tests/fixtures/external/**` | 浏览器扩展和妙手、Canvas、LLM、汇率、临时图片适配器 |
| Core | `.worktrees/w1-core` | `packages/domain/**`, `packages/db/**`, `apps/worker/**`, `tests/fixtures/domain/**` | 领域规则、数据库、素材归档、任务租约、自动化与审批 |
| Web | `.worktrees/w1-web` | `apps/web/**` | API、商品工作台、详情抽屉、任务中心、模板库和设置 |
| Coordinator | 当前集成工作区 | 根文件、`packages/contracts/**`, `packages/config/**`, `apps/worker/src/entry.ts`, `e2e/**`, `.github/**`, `docs/**` | 契约冻结、依赖、composition root、评审、合流、全仓验证 |

并行 Agent 不得修改根 `package.json`、`pnpm-lock.yaml`、workspace 配置、共享 tsconfig 或其他泳道目录。需要新增依赖时，Agent 在交付说明中列出包名和用途，由主协调 Agent 在合流关卡统一安装并更新锁文件。

### 1.2 Dependency graph

```text
Task 1 Repository Foundation
        ↓
Task 2 Contracts v1 + Config v1
        ↓ G0
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 3 Edge  │ Task 4 Core  │ Task 5 Web   │  Wave 1
 └──────────────┴──────────────┴──────────────┘
        ↓ G1 merge and contract tests
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 7 Edge  │ Task 8 Core  │ Task 9 Web   │  Wave 2
 └──────────────┴──────────────┴──────────────┘
        ↓ G2 vertical slice
 ┌──────────────┬──────────────┬──────────────┐
 │ Task 11 Edge │ Task 12 Core │ Task 13 Web  │  Wave 3
 └──────────────┴──────────────┴──────────────┘
        ↓ G3 full mocked flow
Task 15 Hardening + release acceptance
```

合流顺序固定为 Contracts → Domain/DB → Adapters/Worker → Web → 根锁文件/E2E。每个泳道必须先通过自己的测试和代码评审；主协调 Agent 再运行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。关卡失败时不创建下一波工作树。

### 1.3 Worktree protocol

执行时先调用 `superpowers:using-git-worktrees` 检查当前检出是否已经隔离，并优先使用平台原生工作树能力。若没有原生能力，主协调 Agent 使用以下 Git fallback；Task 1 已保证 `.worktrees/` 被忽略：

```bash
git switch -c integration/tk-mvp
git worktree add .worktrees/w1-edge -b agent/w1-edge integration/tk-mvp
git worktree add .worktrees/w1-core -b agent/w1-core integration/tk-mvp
git worktree add .worktrees/w1-web -b agent/w1-web integration/tk-mvp
```

G1/G2/G3 的合流提交完成后，先确认各旧工作树 `git status --short` 为空，再移除旧工作树，并把命令中的 `w1` 依次替换为 `w2`、`w3`，从最新 `integration/tk-mvp` 创建下一波。主协调 Agent 不在开发工作树中直接修复代码；评审不通过时把具体问题退回原 Agent。

每个工作树创建后、Agent 开始编辑前都运行 `corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile && pnpm test`。若基线失败，Agent 停止开发并把输出返回主协调 Agent。

---

### Task 1: Repository Foundation and Clean Baseline

**Owner:** Coordinator, serial before any worktree is created.

**Files:**
- Create: `.gitignore`
- Create: `.node-version`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.mjs`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/index.ts`
- Create: `apps/extension/package.json`
- Create: `apps/extension/tsconfig.json`
- Create: `apps/extension/vite.config.ts`
- Create: `apps/extension/index.html`
- Create: `apps/extension/src/index.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/index.ts`
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`
- Create: `packages/adapters/package.json`
- Create: `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/index.ts`
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/index.ts`
- Test: `tests/foundation/workspace.test.ts`

**Interfaces:**
- Produces: workspace package names `@tk/web`, `@tk/worker`, `@tk/extension`, `@tk/contracts`, `@tk/domain`, `@tk/db`, `@tk/adapters`, `@tk/config`.
- Produces: root commands `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `db:generate`, `db:migrate`.

- [ ] **Step 1: Add a failing foundation test**

```ts
// tests/foundation/workspace.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace baseline", () => {
  it("pins Node 22 and pnpm 9", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.engines.node).toBe(">=22 <23");
    expect(root.packageManager).toBe("pnpm@9.15.9");
  });

  it("contains all eight workspace packages", async () => {
    const yaml = await readFile("pnpm-workspace.yaml", "utf8");
    expect(yaml).toContain("apps/*");
    expect(yaml).toContain("packages/*");
  });
});
```

- [ ] **Step 2: Verify the test fails before the workspace exists**

Run: `corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm exec vitest run tests/foundation/workspace.test.ts`

Expected: FAIL because the root manifest or Vitest executable does not exist.

- [ ] **Step 3: Create the workspace manifests and shared tooling**

The root manifest must include:

```json
{
  "name": "tk-commerce-workbench",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "dev": "pnpm --parallel --filter @tk/web --filter @tk/worker dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:integration": "vitest run --project integration",
    "test:e2e": "playwright test",
    "db:generate": "pnpm --filter @tk/db db:generate",
    "db:migrate": "pnpm --filter @tk/db db:migrate"
  }
}
```

Each package manifest must define working `lint`, `typecheck`, `test`, and `build` scripts; Web and Worker also define `dev`, and Extension defines `dev` plus `build`. The minimal source entries return static content or export an empty typed module so every root command has real work and exits 0 before features are added.

`.gitignore` must include `.worktrees/`, `.superpowers/`, `.env`, `node_modules/`, `.next/`, `dist/`, `coverage/`, `data/` and Playwright artifacts. `docker-compose.yml` must expose PostgreSQL 16 only on loopback and create separate `tk_workbench` and `tk_workbench_test` databases. `.env.example` must name, without values: `DATABASE_URL`, `TEST_DATABASE_URL`, `LOCAL_OPERATOR_ID`, `EXTENSION_TOKEN`, `ALLOW_LAN`, `EXTERNAL_ADAPTER_MODE`, `MIAOSHOU_APP_KEY`, `MIAOSHOU_APP_SECRET`, `CANVAS_BASE_URL`, `CANVAS_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `EXCHANGE_RATE_BASE_URL`, `ASSET_ROOT`, `WORKER_CONCURRENCY`, `WORKER_LEASE_MS`, `MAX_CANVAS_RUNS_PER_DAY`.

Install exact foundation versions centrally so workers never edit the root dependency graph:

```bash
pnpm add -Dw typescript@5.9.3 vitest@4.1.10 eslint@10.7.0 tsx@4.23.1 @playwright/test@1.61.1 jsdom@29.1.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 @testing-library/jest-dom@6.9.1 @types/node@22.20.1
pnpm --filter @tk/web add next@16.2.10 react@19.2.7 react-dom@19.2.7 zod@4.4.3
pnpm --filter @tk/web add -D eslint-config-next@16.2.10 @types/react@19.2.17 @types/react-dom@19.2.3
pnpm --filter @tk/contracts add zod@4.4.3
pnpm --filter @tk/domain add decimal.js@10.6.0
pnpm --filter @tk/db add drizzle-orm@0.45.2 pg@8.22.0
pnpm --filter @tk/db add -D drizzle-kit@0.31.10 @types/pg@8.20.0
pnpm --filter @tk/extension add -D vite@8.1.4
```

- [ ] **Step 4: Install the locked baseline and run all empty-package checks**

Run: `pnpm install && pnpm test && pnpm lint && pnpm typecheck && pnpm build`

Expected: all commands exit 0; the workspace test reports 2 passing tests.

- [ ] **Step 5: Commit the foundation**

```bash
git add .gitignore .node-version package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts eslint.config.mjs docker-compose.yml .env.example apps packages tests/foundation
git commit -m "chore: bootstrap commerce workbench workspace"
```

---

### Task 2: Contracts v1, State Axes, Adapter Ports, and Configuration

**Owner:** Coordinator. Edge Agent may draft; Core and Web Agents must review before G0.

**Files:**
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/quantities.ts`
- Create: `packages/contracts/src/states.ts`
- Create: `packages/contracts/src/commands.ts`
- Create: `packages/contracts/src/read-models.ts`
- Create: `packages/contracts/src/jobs.ts`
- Create: `packages/contracts/src/ports.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/testing/fake-ports.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`
- Create: `packages/config/src/env.ts`
- Create: `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `IngestLinksV1`, `StartAutomationV1`, `ConfirmMiaoshouEditV1`; the confirmation command carries product ID, expected draft/listing/pricing/template versions and ordered final asset IDs, not a pre-created snapshot ID.
- Produces: `ProductPoolItemV1`, `ProductWorkspaceV1`, `TaskCenterItemV1`, `ApprovalPreviewV1`, `ApprovalSnapshotV1`, `TemplateV1`, `WorkspaceSettingsViewV1`.
- Produces: ports `MiaoshouSourcePort`, `MiaoshouEditPort`, `CanvasPort`, `LlmPort`, `ExchangeRatePort`, `AssetStagingPort`, plus deterministic fake implementations and call counters usable by every lane without importing `@tk/adapters`.
- Produces: `ExternalFailure = retryable | needs_input | reconcile_required | fatal` and all state axes from the Spec.

- [ ] **Step 1: Write contract tests that encode the two human gates and units**

```ts
import { describe, expect, it } from "vitest";
import { ConfirmMiaoshouEditV1, IngestLinksV1, StartAutomationV1 } from "./commands";

describe("command contracts", () => {
  it("accepts selected 1688 links only", () => {
    const result = IngestLinksV1.safeParse({
      version: 1,
      batchId: "batch_01",
      items: [{ sourceUrl: "https://detail.1688.com/offer/892408514788.html", idempotencyKey: "1688:892408514788:batch_01" }]
    });
    expect(result.success).toBe(true);
  });

  it("requires explicit commands for processing and Miaoshou edit", () => {
    expect(StartAutomationV1.parse({ version: 1, revisionIds: ["rev_01"] }).revisionIds).toHaveLength(1);
    const confirm = ConfirmMiaoshouEditV1.parse({
      version: 1,
      productId: "product_01",
      expectedDraftVersion: 3,
      expectedListingRunId: "listing_run_01",
      expectedPricingRunId: "pricing_run_01",
      expectedTemplateVersion: 2,
      orderedFinalAssetIds: ["asset_01", "asset_02"]
    });
    expect(confirm.expectedDraftVersion).toBe(3);
  });
});
```

- [ ] **Step 2: Run contract tests and verify they fail**

Run: `pnpm --filter @tk/contracts test`

Expected: FAIL because command schemas and exports do not exist.

- [ ] **Step 3: Implement the exact public contract surface**

```ts
export type MoneyWire = Readonly<{ amountMinor: string; currency: "CNY" | "THB" }>;
export type WeightKg = Readonly<{ value: string; unit: "kg" }>;
export type DimensionsCm = Readonly<{ length: string; width: string; height: string; unit: "cm" }>;

export type AutomationState = "not_started" | "queued" | "running" | "paused" | "needs_input" | "ready" | "failed" | "cancelled";
export type CanvasState = "not_started" | "queued" | "running" | "partial" | "succeeded" | "failed";
export type MiaoshouEditState = "not_started" | "queued" | "syncing" | "result_unknown" | "succeeded" | "failed";

export type ExternalFailure = Readonly<{
  kind: "retryable" | "needs_input" | "reconcile_required" | "fatal";
  code: string;
  safeMessage: string;
}>;
```

Use Zod schemas for commands and serializable DTOs. Define canonical source resolution with separate `fetchDetailId`, `skippedDetailId`, and `canonicalSuccessDetailId`; no field may ambiguously hold more than one meaning. Define job kinds for `miaoshou_collect`, `asset_archive`, `listing_generate`, `pricing_calculate`, `canvas_generate`, and `miaoshou_edit` with versioned payload snapshots.

Wire contracts use decimal strings for integer minor units because JSON cannot serialize BigInt. `@tk/domain` may decode `MoneyWire.amountMinor` to BigInt for arithmetic and must encode it back through one tested codec. Freeze the mapping `ExternalFailure.kind === "reconcile_required"` → persisted external state `result_unknown`; only a successful reconciliation or explicit terminal reconciliation failure can leave that state, and expired-lease recovery cannot requeue the external write while it remains unknown.

- [ ] **Step 4: Add strict environment parsing and secret-safe views**

`loadConfig()` must reject a non-loopback host unless `ALLOW_LAN=true`, parse the fixed local operator ID, and return only booleans from `getSecretStatus()`. It must parse `EXTERNAL_ADAPTER_MODE` as `mock | live`, default to `mock` in test, and refuse to boot any unit, integration or E2E process in `live` mode. Live source collection, Canvas generation and Miaoshou edit each require an explicit command context with a stable idempotency key.

Run: `pnpm --filter @tk/contracts test && pnpm --filter @tk/config test`

Expected: PASS with command, state, quantity, port and configuration tests.

- [ ] **Step 5: Run Gate G0 and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && git status --short`

Expected: all checks pass and only intended contract/config files are modified.

```bash
git add packages/contracts packages/config pnpm-lock.yaml
git commit -m "feat: freeze workbench contracts v1"
```

---

### Task 3: Wave 1 Edge — 1688 Extension and Miaoshou Source Collection

**Owner:** Edge Agent in `.worktrees/w1-edge`.

**Files:**
- Create: `apps/extension/public/manifest.json`
- Create: `apps/extension/src/content/scan-store.ts`
- Create: `apps/extension/src/content/store-overlay.ts`
- Create: `apps/extension/src/background/submit-selected.ts`
- Create: `apps/extension/src/options/token-settings.ts`
- Create: `apps/extension/src/shared/normalize-1688-url.ts`
- Create: `apps/extension/src/shared/normalize-1688-url.test.ts`
- Create: `apps/extension/src/content/scan-store.test.ts`
- Create: `apps/extension/src/background/submit-selected.test.ts`
- Create: `packages/adapters/src/miaoshou/client.ts`
- Create: `packages/adapters/src/miaoshou/source-adapter.ts`
- Create: `packages/adapters/src/miaoshou/source-adapter.test.ts`
- Create: `tests/fixtures/external/miaoshou/fetch-success.json`
- Create: `tests/fixtures/external/miaoshou/fetch-duplicate-skip.json`
- Create: `tests/fixtures/external/miaoshou/detail-3799770548.json`

**Interfaces:**
- Consumes: `IngestLinksV1`, `MiaoshouSourcePort`, canonical source record contracts.
- Produces: `normalize1688OfferUrl(url): { sourceItemId: string; canonicalUrl: string }`.
- Produces: `MiaoshouSourceAdapter.collect(url, idempotencyKey)` that returns the canonical successful detail even when `fetch_item` returns a duplicate skip.

- [ ] **Step 1: Write failing URL and duplicate-resolution tests**

```ts
it("removes tracking parameters from a 1688 offer URL", () => {
  expect(normalize1688OfferUrl("https://detail.1688.com/offer/892408514788.html?spm=x&offerId=892408514788")).toEqual({
    sourceItemId: "892408514788",
    canonicalUrl: "https://detail.1688.com/offer/892408514788.html"
  });
});

it("resolves duplicate skip to the existing success detail", async () => {
  const result = await adapter.collect("https://detail.1688.com/offer/892408514788.html", "idem_01");
  expect(result.fetchDetailId).toBe("3801638367");
  expect(result.canonicalSuccessDetailId).toBe("3799770548");
  expect(result.detail.skus).toHaveLength(28);
});
```

Extension tests must cover visible-card parsing, lazy-loaded cards, selection persistence, duplicate URL removal, selected-only batch submission and pause/resume after a loopback API failure. Miaoshou detail mapping tests must assert category, source price, stock, weight, nine gallery images, five detail HTML images, source/sale attributes, four colors, seven sizes and all 28 SKU mappings; absent package dimensions, item numbers, size chart, video, certifications and supplier data remain explicit missing fields with warning codes.

- [ ] **Step 2: Verify both tests fail, then implement the minimum adapter and extension flow**

Run: `pnpm --filter @tk/extension test && pnpm --filter @tk/adapters test -- source-adapter`

Expected before implementation: FAIL on missing exports. Expected after implementation: PASS.

The Manifest V3 extension requests only the 1688 host and loopback API permissions. The content script must scan visible product cards, keep selection state while the page lazy-loads, show a preview list, and send only selected canonical links. The options page stores the original extension token in `chrome.storage.local`; only the server stores and compares its SHA-256 digest. The background script must attach Bearer token and one idempotency key per selected product. The adapter must call `fetch_item`, then query the public collect box by `sourceItemId`; it must never query a known skip detail as if it were canonical.

- [ ] **Step 3: Verify fixture fidelity and secret safety**

Add a test that injects sentinel secrets `TEST_MIAOSHOU_SECRET_DO_NOT_LOG` and `TEST_EXTENSION_TOKEN_DO_NOT_LOG`, exercises success and error logging, serializes fixtures and safe error responses, and asserts neither sentinel appears. Then run `pnpm --filter @tk/adapters test && pnpm --filter @tk/extension test`.

Expected: all tests pass; fixtures contain response bodies and redacted headers only.

- [ ] **Step 4: Commit only Edge-owned files**

```bash
git add apps/extension packages/adapters tests/fixtures/external/miaoshou
git commit -m "feat: collect selected 1688 products through Miaoshou"
```

---

### Task 4: Wave 1 Core — Domain Model, PostgreSQL Schema, and Repositories

**Owner:** Core Agent in `.worktrees/w1-core`.

**Files:**
- Create: `packages/domain/src/product/revision.ts`
- Create: `packages/domain/src/product/quality.ts`
- Create: `packages/domain/src/pricing/calculate-price.ts`
- Create: `packages/domain/src/pricing/calculate-price.test.ts`
- Create: `packages/domain/src/state/project-ui-stage.ts`
- Create: `packages/domain/src/state/project-ui-stage.test.ts`
- Create: `packages/db/src/schema/operators.ts`
- Create: `packages/db/src/schema/catalog.ts`
- Create: `packages/db/src/schema/assets.ts`
- Create: `packages/db/src/schema/automation.ts`
- Create: `packages/db/src/schema/approval.ts`
- Create: `packages/db/src/schema/settings.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/repositories/catalog-repository.ts`
- Create: `packages/db/src/repositories/automation-run-repository.ts`
- Create: `packages/db/src/repositories/job-repository.ts`
- Create: `packages/db/src/repositories/asset-repository.ts`
- Create: `packages/db/src/repositories/approval-repository.ts`
- Create: `packages/db/src/repositories/audit-repository.ts`
- Create: `packages/db/src/migrations/0000_initial.sql`
- Create: `packages/db/src/integration/repositories.test.ts`

**Interfaces:**
- Consumes: all IDs, quantities, states, job payloads and read models from `@tk/contracts`.
- Produces: immutable product revisions, mutable versioned listing drafts, repository transactions, UI stage projection.
- Produces: `JobRepository.claim(owner, now, leaseMs)`, `heartbeat`, `complete`, `fail`, `releaseExpired`.
- Produces: `AutomationRunRepository.createOrReuseAndEnqueue({ revisionId, processingVersion }): Promise<{ runId: string; created: boolean }>` with a unique `(revision_id, processing_version)` key.
- Produces: `ApprovalRepository.confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<{ approvalSnapshotId: string; syncId: string }>`; Task 12 fills the snapshot mapping but Web may compile against this frozen transaction boundary.

- [ ] **Step 1: Write failing pricing, state projection, migration, and repository tests**

```ts
it("calculates THB price with fees and deterministic ending", () => {
  const result = calculateTargetPrice({
    sourceCostCny: "14.80",
    domesticShippingCny: "2.00",
    crossBorderCostCny: "6.00",
    cnyToTargetRate: "4.80",
    fixedTargetCostThb: "10.00",
    platformFeeRate: "0.05",
    paymentFeeRate: "0.03",
    targetProfitRate: "0.30",
    ending: "9"
  });
  expect(result.currency).toBe("THB");
  expect(result.amountMinor % 1000n).toBe(900n);
});
```

Integration tests must migrate an empty PostgreSQL 16 database, upsert the fixed local operator, create one product with two revisions without overwriting the first, and prove two workers cannot claim the same job. The integration runner must refuse a non-loopback `TEST_DATABASE_URL`, refuse a database name that does not end in `_test`, and never fall back to `DATABASE_URL`.

Quality tests freeze these rules: missing source item ID or every usable product image is `invalid`; missing title, source price, SKU, weight or a subset of attributes is `partial`; otherwise collection is `complete`. Warning codes are stable contract values such as `missing_title`, `missing_source_price`, `missing_sku`, `missing_weight`, `missing_dimensions`, `missing_size_chart`, `missing_video`, and `missing_certification`. A new idempotency key for the same source product creates a new immutable revision and working draft version; it invalidates any approval that referenced the older draft, while a repeated identical idempotency key returns the original result unchanged.

- [ ] **Step 2: Run tests and verify failure**

Run: `docker compose up -d postgres && pnpm --filter @tk/domain test && pnpm --filter @tk/db test:integration`

Expected: FAIL because schema, migration and domain functions do not exist.

- [ ] **Step 3: Implement all Spec aggregates and repositories**

The initial migration must create `local_operators`, `source_shops`, `products`, `product_revisions`, `miaoshou_source_records`, `skus`, `sku_dimensions`, `assets`, `listing_drafts`, `listing_generation_runs`, `pricing_runs`, `exchange_rate_snapshots`, `automation_runs`, `canvas_runs`, `approval_snapshots`, `miaoshou_syncs`, `jobs`, `worker_instances`, `audit_events`, `templates`, and `workspace_settings` with foreign keys and idempotency unique constraints.

`product_revisions` must be immutable. Updating a draft increments its version and invalidates approvals for the previous version. Store money in integer minor units plus currency; store weight and dimensions as decimal strings plus explicit units. `listing_generation_runs` records provider, model, prompt version, input digest and structured output; rule fallback records provider `rules`. `exchange_rate_snapshots` records rate, source, observed time and manual override provenance. Repositories append redacted audit events for collection, start, Canvas submission/result, approval, Miaoshou edit and reconciliation.

- [ ] **Step 4: Run unit and integration tests**

Run: `pnpm --filter @tk/domain test && pnpm --filter @tk/db test:integration`

Expected: PASS; clean database migrates once and a second migration run is a no-op.

- [ ] **Step 5: Commit only Core-owned files**

```bash
git add packages/domain packages/db tests/fixtures/domain
git commit -m "feat: add product graph and durable job schema"
```

---

### Task 5: Wave 1 Web — Fixture-Driven Hybrid Workbench UI

**Owner:** Web Agent in `.worktrees/w1-web`.

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/products/[productId]/page.tsx`
- Create: `apps/web/src/components/navigation/sidebar.tsx`
- Create: `apps/web/src/components/products/stage-overview.tsx`
- Create: `apps/web/src/components/products/product-table.tsx`
- Create: `apps/web/src/components/products/product-drawer.tsx`
- Create: `apps/web/src/components/products/automation-progress.tsx`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/fixtures.ts`
- Create: `apps/web/src/components/products/product-workbench.test.tsx`

**Interfaces:**
- Consumes: `ProductPoolItemV1`, `ProductWorkspaceV1`, `TaskCenterItemV1` only; no DB schema import.
- Produces: selected stage filter, persistent row selection, right detail drawer, single/batch start callbacks.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("keeps selected rows when the detail drawer opens and closes", async () => {
  render(<ProductWorkbench initialItems={fixtures.productPool} />);
  await user.click(screen.getByRole("checkbox", { name: /892408514788/ }));
  await user.click(screen.getByRole("button", { name: /查看详情/ }));
  await user.click(screen.getByRole("button", { name: /关闭详情/ }));
  expect(screen.getByRole("checkbox", { name: /892408514788/ })).toBeChecked();
  expect(screen.getByRole("button", { name: /批量开始处理（1）/ })).toBeEnabled();
});
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `pnpm --filter @tk/web test -- product-workbench`

Expected: FAIL because the workbench components do not exist.

- [ ] **Step 3: Implement the approved fusion layout against fixtures**

Implement left navigation, clickable stage cards, dense table, automatic progress segments and a right drawer. Stage clicks filter rows; they do not mutate status. Closing the drawer must preserve stage filter, selection and scroll. Full SKU/image/title/price editing links to the full product page rather than overloading the drawer.

- [ ] **Step 4: Verify accessibility and production build**

Run: `pnpm --filter @tk/web test && pnpm --filter @tk/web typecheck && pnpm --filter @tk/web build`

Expected: PASS; controls have accessible names and no component imports `@tk/db`.

- [ ] **Step 5: Commit only Web-owned files**

```bash
git add apps/web
git commit -m "feat: add hybrid product workbench UI"
```

---

### Task 6: Gate G1 — Review and Merge Wave 1

**Owner:** Coordinator.

**Files:**
- Modify only if required: root `package.json`, `pnpm-lock.yaml`
- Create: `docs/development/agent-ownership.md`

- [ ] **Step 1: Review each branch for scope and tests**

Run in every worktree: `git diff --name-only "$(git merge-base HEAD integration/tk-mvp)"...HEAD`

Expected: each branch only touches its owned paths. Reject cross-lane edits before merge.

- [ ] **Step 2: Merge in dependency order and regenerate one lockfile**

```bash
git merge --no-ff agent/w1-core -m "merge: wave one core"
git merge --no-ff agent/w1-edge -m "merge: wave one edge"
git merge --no-ff agent/w1-web -m "merge: wave one web"
corepack prepare pnpm@9.15.9 --activate
pnpm install
```

If a merge conflicts outside the owning lane, abort that merge and return it to the responsible Agent; the Coordinator does not invent a cross-lane resolution.

- [ ] **Step 3: Run Gate G1**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build`

Expected: all pass; the successful and duplicate-skip Miaoshou fixtures resolve to canonical detail `3799770548`; the Web fixture DTOs compile against `@tk/contracts`.

- [ ] **Step 4: Commit the integration gate and remove clean Wave 1 worktrees**

```bash
git add package.json pnpm-lock.yaml docs/development/agent-ownership.md
git commit -m "chore: integrate wave one foundations"
git worktree remove .worktrees/w1-edge
git worktree remove .worktrees/w1-core
git worktree remove .worktrees/w1-web
```

---

### Task 7: Wave 2 Edge — Canvas, LLM, Exchange Rate, and Asset Staging Adapters

**Owner:** Edge Agent in `.worktrees/w2-edge`.

**Files:**
- Create: `packages/adapters/src/canvas/canvas-adapter.ts`
- Create: `packages/adapters/src/canvas/canvas-adapter.test.ts`
- Create: `packages/adapters/src/llm/openai-compatible-adapter.ts`
- Create: `packages/adapters/src/llm/openai-compatible-adapter.test.ts`
- Create: `packages/adapters/src/exchange-rate/exchange-rate-adapter.ts`
- Create: `packages/adapters/src/staging/asset-staging-adapter.ts`
- Create: `packages/adapters/src/testing/fakes.ts`
- Create: `packages/adapters/src/factory.ts`
- Create: `packages/adapters/src/factory.test.ts`
- Create: `tests/fixtures/external/canvas/tk-workflow-metadata.json`
- Create: `tests/fixtures/external/canvas/tk-workflow-five-results.json`

**Interfaces:**
- Consumes: `CanvasPort`, `LlmPort`, `ExchangeRatePort`, `AssetStagingPort`.
- Produces: deterministic fakes with call counters for cost-boundary tests.
- Produces: `createAdapterBundle(config)` that returns only deterministic mocks when `EXTERNAL_ADAPTER_MODE=mock` and returns live adapters only when an explicit live command context is present.

- [ ] **Step 1: Write failing live-contract fixture tests**

Tests must prove the adapter reads input capacity from metadata, submits at least one and no more than capacity images, leaves unused inputs empty, preserves 1–4 valid outputs as `partial`, and treats zero valid outputs as `failed`. LLM fixtures must prove structured output cannot introduce a material, certification, efficacy claim or parameter absent from the source evidence.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @tk/adapters test -- canvas-adapter openai-compatible`

Expected: FAIL on missing adapters.

- [ ] **Step 3: Implement adapters without business decisions**

Adapters translate contracts, classify errors, apply timeouts and expose remote IDs. They must not choose product images, calculate prices, or decide whether a task is allowed to run. The LLM adapter returns structured title/listing candidates and never invents missing facts; rule fallback belongs to Core. Factory tests must prove test/E2E mode fails closed if configured `live` and never constructs a network client in mock mode.

- [ ] **Step 4: Run adapter tests and commit**

Run: `pnpm --filter @tk/adapters test && pnpm --filter @tk/adapters typecheck`

```bash
git add packages/adapters tests/fixtures/external/canvas
git commit -m "feat: add generation and staging adapters"
```

---

### Task 8: Wave 2 Core — Local Assets, Durable Worker, Listing, Pricing, and Canvas DAG

**Owner:** Core Agent in `.worktrees/w2-core`.

**Files:**
- Create: `packages/domain/src/listing/generate-listing.ts`
- Create: `packages/domain/src/listing/rule-fallback.ts`
- Create: `packages/domain/src/listing/generate-listing.test.ts`
- Create: `packages/domain/src/assets/select-canvas-inputs.ts`
- Create: `packages/domain/src/assets/select-canvas-inputs.test.ts`
- Create: `packages/domain/src/assets/validate-remote-url.ts`
- Create: `packages/domain/src/assets/validate-remote-url.test.ts`
- Create: `packages/domain/src/assets/score-image.ts`
- Create: `packages/domain/src/assets/score-image.test.ts`
- Create: `packages/domain/src/templates/match-template.ts`
- Create: `packages/domain/src/templates/match-template.test.ts`
- Create: `packages/domain/src/automation/graph.ts`
- Create: `packages/domain/src/automation/cost-boundary.test.ts`
- Create: `packages/db/src/assets/content-addressed-store.ts`
- Create: `packages/db/src/assets/content-addressed-store.test.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/runtime/worker-loop.ts`
- Create: `apps/worker/src/handlers/collect.ts`
- Create: `apps/worker/src/handlers/archive-assets.ts`
- Create: `apps/worker/src/handlers/generate-listing.ts`
- Create: `apps/worker/src/handlers/calculate-pricing.ts`
- Create: `apps/worker/src/handlers/refresh-exchange-rate.ts`
- Create: `apps/worker/src/handlers/generate-canvas.ts`
- Create: `apps/worker/src/runtime/recovery.test.ts`

**Interfaces:**
- Consumes: repositories and Adapter ports through dependency injection.
- Produces: `runWorkerLoop({ repositories, ports, clock })` and leased job handlers through `ready` preview. The Worker never creates automation runs; Web calls the frozen `AutomationRunRepository.createOrReuseAndEnqueue()` transaction and Worker only claims persisted jobs.

- [ ] **Step 1: Write failing cost-boundary, selection, archive, and recovery tests**

```ts
it("does not call paid services before explicit start", async () => {
  const fakes = createFakePorts();
  await runtime.importCollectedRevision(fixtureRevision);
  expect(fakes.llm.calls).toBe(0);
  expect(fakes.exchangeRate.calls).toBe(0);
  expect(fakes.canvas.calls).toBe(0);
});

it("reuses the same automation run on repeated start", async () => {
  const first = await automationRuns.createOrReuseAndEnqueue({ revisionId: "rev_01", processingVersion: 1 });
  const second = await automationRuns.createOrReuseAndEnqueue({ revisionId: "rev_01", processingVersion: 1 });
  expect(second.runId).toBe(first.runId);
});
```

`createFakePorts()` comes from `@tk/contracts/testing`, so Core tests have no same-wave dependency on `@tk/adapters`. Also test that LLM failure invokes deterministic rule cleaning and marks the result as degraded; the daily exchange-rate refresh persists its source/time, reads the latest successful snapshot on outage, marks stale data, and honors a recorded manual override; missing weight, cost or valid rate produces `needs_input`; unmatched categories use the workspace default template; external download validation rejects loopback, private, link-local and cloud metadata addresses before any request is sent.

- [ ] **Step 2: Run and verify failures**

Run: `pnpm --filter @tk/domain test && pnpm --filter @tk/db test && pnpm --filter @tk/worker test`

Expected: FAIL because runtime, asset store and handlers do not exist.

- [ ] **Step 3: Implement atomic local assets and the automation DAG**

Write assets to a temporary file, hash while streaming, fsync, then atomically rename to `data/assets/${sha256.slice(0, 2)}/${sha256}.${normalizedExtension}`. Allow only HTTP/HTTPS downloads, follow a bounded redirect count, and revalidate every resolved address after redirects. Image scoring persists pixel dimensions, perceptual hash, clarity, duplicate distance, watermark, collage/non-product signals, configurable visual score, chosen role and rejection reason. The DAG order is archive → listing → pricing → match template → select images → Canvas → final preview. A failed product must not stop sibling jobs. Lease expiry recovery must reconcile remote IDs before reissuing Canvas work. Global pause, batch pause/resume, task cancel and safe retry operate through persisted job state rather than in-memory flags. Before Canvas submission, atomically reserve against `MAX_CANVAS_RUNS_PER_DAY`; exceeding the limit pauses the run without external calls. Workspace concurrency and rate limits bound each adapter independently. Every human start and every external call/result appends a redacted audit event.

- [ ] **Step 4: Run tests including process-restart recovery**

Run: `pnpm --filter @tk/domain test && pnpm --filter @tk/db test && pnpm --filter @tk/worker test`

Expected: PASS; duplicate starts create one Canvas call; Worker restart continues from persisted jobs.

- [ ] **Step 5: Commit only Core-owned files**

```bash
git add packages/domain packages/db apps/worker tests/fixtures/domain
git commit -m "feat: add durable automatic processing pipeline"
```

---

### Task 9: Wave 2 Web — Ingest, Product, Start, Task, Template, and Settings APIs

**Owner:** Web Agent in `.worktrees/w2-web`.

**Files:**
- Create: `apps/web/src/app/api/v1/ingest-links/route.ts`
- Create: `apps/web/src/app/api/v1/products/route.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/route.ts`
- Create: `apps/web/src/app/api/v1/automation-runs/route.ts`
- Create: `apps/web/src/app/api/v1/tasks/route.ts`
- Create: `apps/web/src/app/api/v1/tasks/[taskId]/actions/route.ts`
- Create: `apps/web/src/app/api/v1/templates/route.ts`
- Create: `apps/web/src/app/api/v1/settings/route.ts`
- Create: `apps/web/src/server/auth/extension-token.ts`
- Create: `apps/web/src/server/services/ingest-service.ts`
- Create: `apps/web/src/server/services/product-service.ts`
- Create: `apps/web/src/server/services/automation-service.ts`
- Create: `apps/web/src/server/services/task-service.ts`
- Create: `apps/web/src/server/services/template-service.ts`
- Create: `apps/web/src/server/services/settings-service.ts`
- Create: `apps/web/src/app/api/v1/api.integration.test.ts`

**Interfaces:**
- Consumes: Contract v1 commands/read models and repositories; API route files never import external adapter implementations directly.
- Produces: authenticated loopback endpoints and UI API client implementations.

- [ ] **Step 1: Write failing API integration tests**

Tests must submit two selected links, reject a bad token, return the same queued job for a repeated idempotency key, start one or many existing revisions through `AutomationRunRepository.createOrReuseAndEnqueue()`, and return one run ID per revision. Web-only tests do not expect an asynchronously imported product because no Worker runs in this task; the imported `not_started` assertion belongs to Task 10 E2E.

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @tk/web test -- api.integration`

Expected: FAIL with missing routes/services.

- [ ] **Step 3: Implement short-request services**

`POST /api/v1/ingest-links` validates Bearer token with a SHA-256 digest and constant-time comparison, then queues `miaoshou_collect`. `POST /api/v1/automation-runs` calls the repository's single transaction to create or reuse runs and queue only the first free job. Both human commands append redacted audit events in the same transaction. Product GET endpoints project database states into Contract v1 read models. Settings returns secret status booleans only.

- [ ] **Step 4: Connect the Wave 1 UI to the API client**

The Web UI must show pending, partial and failed records without losing selection. Starting a batch disables only the submitted rows until the API responds; a failed row remains retryable without rolling back successful siblings.

- [ ] **Step 5: Test and commit**

Run: `pnpm --filter @tk/web test && pnpm --filter @tk/web typecheck && pnpm --filter @tk/web build`

```bash
git add apps/web
git commit -m "feat: add collection and automation APIs"
```

---

### Task 10: Gate G2 — First Vertical Slice and Cost Boundary

**Owner:** Coordinator.

**Files:**
- Create: `e2e/fixtures/miaoshou-server.ts`
- Create: `e2e/collection-to-product-pool.spec.ts`
- Create: `apps/worker/src/entry.ts`
- Create: `apps/worker/src/entry.test.ts`

- [ ] **Step 1: Merge Wave 2 in dependency order and update the root lockfile**

```bash
git merge --no-ff agent/w2-core -m "merge: wave two core"
git merge --no-ff agent/w2-edge -m "merge: wave two edge"
git merge --no-ff agent/w2-web -m "merge: wave two web"
pnpm install
```

- [ ] **Step 2: Add a vertical-slice Playwright/API test**

The test runs Mock Miaoshou, Web, Worker and PostgreSQL; submits the real sample URL; verifies both first-success and duplicate-skip paths produce one canonical product revision; then checks fake LLM, exchange-rate and Canvas call counters remain zero.

`apps/worker/src/entry.ts` is the post-merge composition root: it calls `createAdapterBundle(loadConfig())` and injects the returned ports into `runWorkerLoop`. Its test sets `NODE_ENV=test` and proves `EXTERNAL_ADAPTER_MODE=live` aborts before any socket or HTTP client is created. All E2E process launchers set `EXTERNAL_ADAPTER_MODE=mock` and `TEST_DATABASE_URL` explicitly.

- [ ] **Step 3: Run Gate G2**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm exec playwright test e2e/collection-to-product-pool.spec.ts && pnpm build`

Expected flow:

```text
selected links -> Mock Miaoshou fetch/skip -> canonical detail
-> immutable revision -> product pool not_started
-> LLM calls 0, exchange-rate calls 0, Canvas calls 0
```

- [ ] **Step 4: Commit the gate and remove Wave 2 worktrees**

```bash
git add package.json pnpm-lock.yaml apps/worker/src/entry.ts apps/worker/src/entry.test.ts e2e
git commit -m "test: verify collection cost boundary"
git worktree remove .worktrees/w2-edge
git worktree remove .worktrees/w2-core
git worktree remove .worktrees/w2-web
```

---

### Task 11: Wave 3 Edge — Miaoshou Edit Mapping and Result Reconciliation

**Owner:** Edge Agent in `.worktrees/w3-edge`.

**Files:**
- Create: `packages/adapters/src/miaoshou/edit-mapper.ts`
- Create: `packages/adapters/src/miaoshou/edit-adapter.ts`
- Create: `packages/adapters/src/miaoshou/reconcile-edit.ts`
- Create: `packages/adapters/src/miaoshou/edit-adapter.test.ts`
- Create: `tests/fixtures/external/miaoshou/edit-validation-error.json`
- Create: `tests/fixtures/external/miaoshou/edit-success.json`

**Interfaces:**
- Consumes: immutable `ApprovalSnapshotV1` and `MiaoshouEditPort`.
- Produces: one edit payload targeting `canonicalSuccessDetailId`; reconciliation by canonical ID, source item ID and item number.

- [ ] **Step 1: Write failing mapper and unknown-result tests**

Tests must prove CNY/THB, kg and cm are converted exactly once; ordered final images become remote URLs; an HTTP timeout yields `reconcile_required`; retry is blocked until reconciliation completes.

- [ ] **Step 2: Implement mapper, validation mapping and reconciliation**

The adapter must never call claim, TikTok collect-box edit, or publish endpoints. Field validation errors return stable field paths suitable for the UI. A successful reconciliation records the remote result without re-editing.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter @tk/adapters test -- edit-adapter`

```bash
git add packages/adapters tests/fixtures/external/miaoshou
git commit -m "feat: edit canonical Miaoshou collect-box products"
```

---

### Task 12: Wave 3 Core — Approval Snapshots, Invalidation, and Final Sync Job

**Owner:** Core Agent in `.worktrees/w3-core`.

**Files:**
- Create: `packages/domain/src/approval/create-snapshot.ts`
- Create: `packages/domain/src/approval/create-snapshot.test.ts`
- Create: `packages/domain/src/approval/invalidate-approval.ts`
- Create: `apps/worker/src/handlers/miaoshou-edit.ts`
- Create: `apps/worker/src/handlers/miaoshou-edit.test.ts`
- Modify: `packages/db/src/repositories/approval-repository.ts`
- Modify: `packages/db/src/repositories/job-repository.ts`

**Interfaces:**
- Consumes: ready automation run, versioned draft, pricing run, canvas outputs, canonical Miaoshou detail ID.
- Produces: the already frozen `ApprovalRepository.confirmAndEnqueue(command)` transaction, an immutable approval snapshot and one idempotent `miaoshou_edit` job.

- [ ] **Step 1: Write failing snapshot and invalidation tests**

Tests must assert the snapshot includes source identity, locale/currency/channel, title/description/attributes, item number, price/stock/weight/dimensions with units, SKU relations, ordered assets and all version IDs. Editing title, image order, language, template or price invalidates the snapshot.

- [ ] **Step 2: Write a failing result-unknown recovery test**

Simulate Worker crash after remote acceptance but before local commit. On restart, the handler must call reconcile and must not call edit again.

- [ ] **Step 3: Implement transactional approval and sync job creation**

One database transaction compares all expected versions and ordered final asset IDs, rejects stale confirmation with HTTP-facing conflict metadata, creates the snapshot and queues the job. The Worker stages approved local images, performs reachability checks, calls the edit port, persists field errors or remote mapping, and releases temporary URLs after completion. `reconcile_required` writes `miaoshou_syncs.state=result_unknown`; expired-lease recovery may only schedule reconciliation until that state is resolved. Approval, edit and reconciliation append redacted audit events.

- [ ] **Step 4: Test and commit**

Run: `pnpm --filter @tk/domain test && pnpm --filter @tk/worker test`

```bash
git add packages/domain packages/db apps/worker
git commit -m "feat: add immutable approval and Miaoshou sync"
```

---

### Task 13: Wave 3 Web — Final Review, Task Center, Templates, and Settings

**Owner:** Web Agent in `.worktrees/w3-web`.

**Files:**
- Create: `apps/web/src/app/products/[productId]/review/page.tsx`
- Create: `apps/web/src/app/tasks/page.tsx`
- Create: `apps/web/src/app/templates/page.tsx`
- Create: `apps/web/src/app/settings/page.tsx`
- Create: `apps/web/src/app/api/v1/products/[productId]/draft/route.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/rerun/route.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/confirm-miaoshou-edit/route.ts`
- Create: `apps/web/src/app/api/v1/miaoshou-syncs/route.ts`
- Create: `apps/web/src/components/review/original-listing-panel.tsx`
- Create: `apps/web/src/components/review/target-listing-panel.tsx`
- Create: `apps/web/src/components/review/pricing-breakdown.tsx`
- Create: `apps/web/src/components/review/final-image-order.tsx`
- Create: `apps/web/src/components/review/approval-actions.tsx`
- Create: `apps/web/src/components/tasks/task-table.tsx`
- Create: `apps/web/src/components/tasks/task-recovery-actions.tsx`
- Create: `apps/web/src/app/final-review.test.tsx`
- Create: `apps/web/src/app/product-safety.test.tsx`

**Interfaces:**
- Consumes: `ProductWorkspaceV1`, `ApprovalPreviewV1`, `ConfirmMiaoshouEditV1`, task/template/settings read models.
- Produces: version-aware draft editing, one atomic confirmation POST and read-only sync status. The `miaoshou-syncs` route supports GET only and cannot create a second external write.

- [ ] **Step 1: Write failing review-flow tests**

Tests must show Chinese original beside Thai draft, price formula, SKU count, warnings, selected images and five Canvas outputs; a draft edit invalidates approval; confirmation button text is exactly “确认并推送妙手”; no “发布 TikTok” action exists.

- [ ] **Step 2: Implement review and operational pages**

The task center groups collection, asset, listing, Canvas and Miaoshou jobs with attempt, retry time and pause reason. Settings allows locale, pricing, non-secret provider options, asset directory, concurrency and retry edits. Miaoshou, Canvas and LLM secret fields are read-only configured/not-configured indicators with instructions to set environment variables; MVP does not write secrets from the browser. Template Library manages category rule, references, prompt fragment, language, style, enabled state and version.

Draft PATCH supports per-product target language and translation-style overrides. Rerun POST accepts the expected draft version plus a start node (`listing | pricing | template | canvas`), invalidates downstream outputs and approvals, and never reruns unaffected upstream collection or original asset archive.

- [ ] **Step 3: Add explicit product-safety assertions**

Run the component/API test `pnpm --filter @tk/web test -- product-safety`, which enumerates rendered actions and registered mutation routes.

Expected: no action or mutation route targets claim, TikTok collect-box edit or publish; explanatory non-goal copy and negative test strings do not fail the check.

- [ ] **Step 4: Test and commit**

Run: `pnpm --filter @tk/web test && pnpm --filter @tk/web typecheck && pnpm --filter @tk/web build`

```bash
git add apps/web
git commit -m "feat: add final review and operations UI"
```

---

### Task 14: Gate G3 — Complete Mocked Business Flow

**Owner:** Coordinator.

**Files:**
- Create: `e2e/full-mocked-flow.spec.ts`
- Create: `e2e/worker-recovery.spec.ts`
- Create: `e2e/ui-context.spec.ts`

- [ ] **Step 1: Merge Wave 3 and update the lockfile**

```bash
git merge --no-ff agent/w3-core -m "merge: wave three core"
git merge --no-ff agent/w3-edge -m "merge: wave three edge"
git merge --no-ff agent/w3-web -m "merge: wave three web"
pnpm install
```

- [ ] **Step 2: Write the full flow before accepting the merged implementation**

```text
extension-like selected links
-> Mock Miaoshou source collection
-> product pool not_started
-> explicit start
-> local archive + Listing + pricing + image selection
-> Mock Canvas TK workflow returns five images
-> ready preview
-> edit draft invalidates prior approval
-> approve current version
-> Mock Miaoshou edits the same canonical detail once
```

The recovery test kills the Worker after a remote task ID is stored and proves restart performs reconciliation without duplicate Canvas or Miaoshou writes. The UI test proves stage filter, selected rows and drawer context persist.

- [ ] **Step 3: Run Gate G3**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm build`

Expected: all pass; fake call counters show exactly one Canvas submission and one canonical Miaoshou edit per approved revision.

- [ ] **Step 4: Commit and remove Wave 3 worktrees**

```bash
git add package.json pnpm-lock.yaml e2e
git commit -m "test: verify complete commerce workbench flow"
git worktree remove .worktrees/w3-edge
git worktree remove .worktrees/w3-core
git worktree remove .worktrees/w3-web
```

---

### Task 15: Parallel Hardening and Release Acceptance

**Owner:** Three review Agents in separate `w4-*` worktrees audit and fix only their owned subsystem paths; Coordinator serially creates CI, scripts and documentation after merging those fixes.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/development/local-setup.md`
- Create: `docs/development/extension-install.md`
- Create: `docs/operations/recovery.md`
- Create: `docs/operations/security.md`
- Create: `scripts/verify-fresh-install.sh`
- Modify: subsystem-owned tests only when a concrete hardening failure is reproduced.

- [ ] **Step 1: Dispatch three independent hardening audits**

Edge audit: external error matrix, live metadata read-only smoke, retry/reconciliation and log redaction. Core audit: migration, lease contention, crash recovery, file atomicity and idempotency. Web audit: Playwright critical flows, keyboard accessibility, responsive desktop layout, error recovery and context retention.

- [ ] **Step 2: Require every finding to start with a failing regression test**

No audit Agent may change production code without a reproducible test or command showing the failure. Fixes remain in owned paths and are reviewed independently.

- [ ] **Step 3: Merge audit fixes, then let the Coordinator add CI and operating docs**

The three audit Agents do not edit `.github/**`, `docs/**` or `scripts/**`. After their independent branches pass, the Coordinator merges them and creates the exact files listed in this task.

- [ ] **Step 4: Verify a fresh machine path**

Run: `bash scripts/verify-fresh-install.sh`

The script must activate pnpm 9.15.9, install from the frozen lockfile, start PostgreSQL, migrate, create the fixed operator, build Web/Worker/Extension, run unit/integration/E2E tests, and stop test services.

- [ ] **Step 5: Run all seventeen MVP acceptance checks from the Spec**

Record each acceptance item as PASS/FAIL with its exact command or Playwright test. A live Miaoshou check is read-only unless the user separately authorizes a write test; real Canvas execution is capped at one explicitly approved test run.

- [ ] **Step 6: Final verification and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm build && git status --short`

Expected: all checks pass; working tree is clean; `.superpowers/`, secrets, local assets and worktree contents are untracked and ignored.

```bash
git add .github docs scripts
git commit -m "docs: add MVP verification and operations guide"
```

---

## 2. Review Gates and Stop Conditions

Stop the current wave and return to the Coordinator if any of the following occurs:

1. A Contract v1 field must be renamed or its meaning changes.
2. An Agent needs to edit another lane's owned directory.
3. PostgreSQL migration is not repeatable from an empty database.
4. A timeout could cause a second Canvas generation or second Miaoshou edit.
5. UI or API introduces claim, TikTok collect-box edit, or publish behavior.
6. A secret appears in git diff, logs, fixture output or browser payload.
7. Baseline tests fail before an Agent's own change.

The Coordinator resolves contract changes first, commits a new integration baseline, removes the current wave's clean worktrees, and recreates them from that baseline. Agents do not cherry-pick each other's in-progress commits.

## 3. Definition of Done

The MVP is complete only when all of the following are demonstrated together:

- Selected 1688 links are imported through Miaoshou and duplicate skips resolve to the canonical success detail.
- Product revisions and original assets are immutable and permanently local.
- No LLM, exchange-rate or Canvas call happens before explicit start.
- Automatic processing produces a configurable-language Listing, auditable Thai price and up to the live Canvas input capacity without duplicate filler images.
- Five Canvas outputs are handled as expected and partial results remain recoverable.
- Worker restart does not duplicate paid or external-write operations.
- Final confirmation snapshots the exact version and edits the same canonical Miaoshou public collect-box record once.
- The approved hybrid UI preserves filters, row selections and detail context.
- There is no MVP path for claim, TikTok collect-box edit or publishing.
- A fresh clone passes install, migration, lint, typecheck, unit, integration, E2E and production build using the frozen lockfile.
