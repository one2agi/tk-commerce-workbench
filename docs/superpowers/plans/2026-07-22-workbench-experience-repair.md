# Workbench Experience Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已跑通的 1688 → 本地工作台 → Canvas `TK工作流` → 妙手 canonical 公共采集箱写回链路，整理成运营能直接使用的商品处理台。

**Architecture:** 不重写采集、Canvas、妙手写回主链路。先在 Web 侧新增稳定的“商品行视图投影”，把内部状态轴翻译成业务状态、图片进度、问题提示和下一步；再调整导航、商品处理台、详情/图片确认页、设置诊断、处理规则和写入记录页面。异常样本通过测试夹具覆盖，真实链路样本由 spec 中 Gate 5 固定样本验证。

**Tech Stack:** TypeScript, Next.js App Router, React 19, Vitest, Testing Library, PostgreSQL JSONB projections, existing `StartAutomationV1`, `RerunDownstreamV1`, `ConfirmMiaoshouEditV1` command contracts.

## Global Constraints

- 用中文面向产品经理解释用户可见变化、业务影响、风险和下一步。
- 不暴露 `.env`、妙手密钥、LLM key、Canvas 配置、扩展令牌。
- 本地单用户，不引入账号登录、权限、团队协作或 SaaS 部署。
- 不自动发布到 TikTok Shop。
- 不自动认领到 TikTok 采集箱。
- 妙手终点是编辑同一条 canonical 妙手公共采集箱商品。
- Canvas 必须使用本地 `http://127.0.0.1:8123` 的 `TK工作流`，输入上限 9 张，期望输出 5 张。
- 人工按钮只保留费用边界、外部写入边界和异常恢复：开始处理、确认写回妙手、查看原因/重试。
- 任务中心从主导航移除，降级为 `设置 → 系统诊断 / 任务日志`。
- 处理规则页只管理标题规则、目标语言风格、禁词/保留词，并展示 Canvas `TK工作流` 绑定说明；不配置属性默认值、参考图或生图风格。
- 属性以妙手采集结果为准，本地只做翻译、清洗、格式校验和缺失提示。
- 设置页不得出现保存后不影响运行的“假配置”；需要 `.env` 或 Worker 重启的字段必须标注运行边界。
- 每个任务先写失败测试，再做最小实现，再跑聚焦验证。

---

## File Structure

- Create: `apps/web/src/components/products/product-row-view.ts`
  - 负责把 `ProductPoolItemV1` 投影成运营可理解的行视图：业务状态、状态 Tab、图片进度、问题提示、下一步动作、批量动作资格。

- Create: `apps/web/src/components/products/product-row-view.test.ts`
  - 覆盖 6 个业务状态、图片进度、人话错误和下一步按钮。

- Modify: `packages/contracts/src/read-models.ts`
  - 给 `ProductPoolItemV1` 增加列表 UI 需要的 `sourceUrl`、`thumbnailUrl`、`collectedAt`、`updatedAt`。

- Modify: `apps/web/src/server/services/product-service.ts`
  - 从 `products.source_url`、`products.created_at`、`products.updated_at`、`product_revisions.source_payload.mainImages/detailImages` 投影新增字段。

- Modify: `apps/web/src/lib/fixtures.ts`
  - 更新本地 fixture，覆盖缩略图、采集时间、已完成、待确认、异常行。

- Modify: `apps/web/src/components/products/product-workbench.selectors.ts`
  - 迁移到 `product-row-view.ts` 的业务状态顺序和标签，保留 `buildAutomationProgress()`。

- Modify: `apps/web/src/components/products/product-workbench.state.ts`
  - 选择逻辑允许选择可执行不同批量动作的行，不再只允许“可开始处理”的行。

- Modify: `apps/web/src/components/products/product-workbench.tsx`
  - 接入刷新、批量开始处理、批量确认写回、批量重试和行视图。

- Modify: `apps/web/src/components/products/product-table.tsx`
  - 表格字段改成图片、标题、来源、采集时间、业务状态、图片进度、问题、下一步、操作。

- Modify: `apps/web/src/components/products/product-table.test.tsx`
  - 验证图片/查看打开详情确认页，状态 Tab 和按钮口径正确。

- Modify: `apps/web/src/components/products/stage-overview.tsx`
  - 文案改为已确认的 Tab：全部、待处理、自动处理中、待确认、需要人工处理、已完成。

- Modify: `apps/web/src/components/navigation/sidebar.tsx`
  - 主导航改成商品、处理规则、写入记录、设置。

- Create: `apps/web/src/app/processing-rules/page.tsx`
  - 新处理规则页，只展示/管理标题规则、语言风格、禁词/保留词和 Canvas `TK工作流` 说明。

- Modify: `apps/web/src/app/templates/page.tsx`
  - 改为重定向或兼容渲染到 `/processing-rules`，避免旧“模板库”继续暴露参考图/风格配置。

- Create: `apps/web/src/app/write-records/page.tsx`
  - 写入记录页，展示妙手写回记录，复用 `miaoshou_syncs` 数据。

- Create: `apps/web/src/server/services/miaoshou-sync-service.ts`
  - 从 `miaoshou_syncs` 读取写入记录，供页面和 API 复用。

- Create: `apps/web/src/server/services/product-rerun-service.ts`
  - 将“需要人工处理”商品映射到安全的 `RerunDownstreamV1` 局部重跑，不直接重试任意后台 job。

- Modify: `apps/web/src/app/api/v1/miaoshou-syncs/route.ts`
  - 复用 `MiaoshouSyncService`，避免页面和 API 各自写 SQL。

- Modify: `apps/web/src/app/settings/page.tsx`
  - 设置页接入系统诊断/任务日志入口。

- Modify: `apps/web/src/components/settings/settings-workspace.tsx`
  - 删除或降级不真实生效的 Provider 默认值表达，新增系统诊断卡片。

- Modify: `apps/web/src/components/settings/sections/provider-options-section.tsx`
  - Canvas 字段改成 `TK工作流` 运行说明，不允许误导用户以为前端保存即可改 Worker 运行工作流。

- Create: `apps/web/src/components/settings/sections/system-diagnostics-section.tsx`
  - 提供任务日志入口、运行边界说明、Canvas/妙手/LLM 配置状态摘要。

- Modify: `apps/web/src/app/products/[productId]/page.tsx`
  - 商品详情页改成进入图片确认/审核体验，复用 `FinalReview` 的核心组件。

- Modify: `apps/web/src/app/products/[productId]/review/page.tsx`
  - 保留兼容路由，和 `/products/{id}` 使用同一渲染函数。

- Modify: `apps/web/src/components/review/final-review.tsx`
  - 调整为左图、中内容、右检查/下一步三区布局。

- Modify: `apps/web/src/components/review/approval-actions.tsx`
  - 主按钮文案统一为“确认写回妙手”，不再使用“推送”。

- Create: `apps/web/src/app/api/v1/products/batch-actions/route.ts`
  - 提供批量确认写回和批量重试的受控入口；不绕过现有版本和确认边界。

- Modify: `apps/web/src/app/final-review.test.tsx`
  - 更新导航、设置、详情页、写入记录和审核文案测试。

- Modify: `apps/web/src/app/products/[productId]/page.test.tsx`
  - 验证商品详情页已成为图片确认/审核页。

- Modify: `e2e/browser-workbench.spec.ts`
  - 验证主导航、商品处理台、查看详情入口和设置诊断入口。

- Create: `e2e/workbench-fixed-samples.spec.ts`
  - 记录 Gate 5 固定样本的 E2E 验收流程；真实外部调用可在 mock 模式下验证 UI 合同，在人工本地验收时切 live。

- Modify: `.sdd/progress.md`
  - Gate 6 计划完成后标记 plan ready。

---

### Task 1: Product-Facing Row Projection

**Files:**
- Create: `apps/web/src/components/products/product-row-view.ts`
- Create: `apps/web/src/components/products/product-row-view.test.ts`
- Modify: `apps/web/src/components/products/product-workbench.selectors.ts`

**Interfaces:**
- Consumes: `ProductPoolItemV1`
- Produces:
  - `ProductBusinessStage = "pending" | "processing" | "review" | "needs_attention" | "synced"`
  - `WorkbenchStageKey = "all" | ProductBusinessStage`
  - `ProductRowView`
  - `buildProductRowView(item: ProductPoolItemV1, startStatus?: StartStatus): ProductRowView`
  - `buildProductIssue(item: ProductPoolItemV1): string | null`
  - `buildImageProgress(item: ProductPoolItemV1): string`

- [ ] **Step 1: Write RED tests for business labels**

Create `apps/web/src/components/products/product-row-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { miaoshouDetailId, productId, productRevisionId, sourceItemId } from "@tk/contracts/ids";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import { buildImageProgress, buildProductIssue, buildProductRowView, STAGE_LABELS, STAGE_ORDER } from "./product-row-view";

function item(overrides: Partial<ProductPoolItemV1> = {}): ProductPoolItemV1 {
  return {
    productId: productId("product-1"),
    currentRevisionId: productRevisionId("revision-1"),
    sourceItemId: sourceItemId("1688-1"),
    sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
    thumbnailUrl: "https://img.test/main.jpg",
    collectedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:10:00.000Z",
    canonicalSourceTitle: "源标题",
    targetTitle: null,
    canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
    locale: "th-TH",
    currency: "THB",
    priceWire: null,
    sourceImageCount: 9,
    imageCount: 0,
    usableCanvasOutputCount: 0,
    miaoshouSource: "success",
    automation: "not_started",
    assetArchive: "pending",
    listing: "pending",
    canvas: "not_started",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: [],
    ...overrides
  };
}

describe("product row view", () => {
  it("uses the approved six workbench tabs", () => {
    expect(STAGE_ORDER).toEqual(["all", "pending", "processing", "review", "needs_attention", "synced"]);
    expect(STAGE_LABELS).toMatchObject({
      all: "全部",
      pending: "待处理",
      processing: "自动处理中",
      review: "待确认",
      needs_attention: "需要人工处理",
      synced: "已完成"
    });
  });

  it("projects pending rows to Start Processing", () => {
    const row = buildProductRowView(item());
    expect(row.businessStage).toBe("pending");
    expect(row.businessStatusLabel).toBe("待处理");
    expect(row.nextAction).toEqual({ kind: "start", label: "开始处理", enabled: true });
    expect(row.canBatchStart).toBe(true);
    expect(row.canBatchConfirm).toBe(false);
  });

  it("projects review rows to View and Confirm", () => {
    const row = buildProductRowView(item({
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      usableCanvasOutputCount: 5,
      targetTitle: "สร้อยคอจี้โคลเวอร์"
    }));
    expect(row.businessStage).toBe("review");
    expect(row.businessStatusLabel).toBe("待确认");
    expect(row.imageProgressLabel).toBe("主图 5/5");
    expect(row.nextAction).toEqual({ kind: "review", label: "查看并确认", enabled: true, href: "/products/product-1" });
    expect(row.canBatchConfirm).toBe(true);
  });

  it("translates blocking issues into human-readable copy", () => {
    expect(buildProductIssue(item({ canonicalSuccessDetailId: null }))).toBe("缺少妙手采集箱详情 ID，无法写回");
    expect(buildProductIssue(item({ sourceImageCount: 0 }))).toBe("妙手原始数据没有可用图片");
    expect(buildProductIssue(item({ canvas: "failed" }))).toBe("Canvas 生图失败，请查看原因或重试");
    expect(buildProductIssue(item({ canvas: "partial", usableCanvasOutputCount: 0 }))).toBe("Canvas 没有返回可用图片");
    expect(buildProductIssue(item({ miaoshouEdit: "result_unknown" }))).toBe("妙手写回结果未知，需要人工对账");
  });

  it("does not count source images as Canvas outputs", () => {
    expect(buildImageProgress(item({ sourceImageCount: 9, usableCanvasOutputCount: 0 }))).toBe("主图 0/5");
    expect(buildImageProgress(item({ sourceImageCount: 9, usableCanvasOutputCount: 5 }))).toBe("主图 5/5");
  });
});
```

- [ ] **Step 2: Run the RED test**

Run:

```bash
pnpm --filter @tk/web test -- product-row-view.test.ts
```

Expected before implementation: FAIL because `product-row-view.ts` does not exist.

- [ ] **Step 3: Implement the projection**

Create `apps/web/src/components/products/product-row-view.ts`:

```ts
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import { projectUiStage } from "@tk/domain/state/project-ui-stage";
import type { StartStatus } from "./product-workbench.state";

export type ProductBusinessStage = "pending" | "processing" | "review" | "needs_attention" | "synced";
export type WorkbenchStageKey = "all" | ProductBusinessStage;

export const STAGE_ORDER: ReadonlyArray<WorkbenchStageKey> = [
  "all",
  "pending",
  "processing",
  "review",
  "needs_attention",
  "synced"
];

export const STAGE_LABELS: Readonly<Record<WorkbenchStageKey, string>> = {
  all: "全部",
  pending: "待处理",
  processing: "自动处理中",
  review: "待确认",
  needs_attention: "需要人工处理",
  synced: "已完成"
};

export type RowAction =
  | Readonly<{ kind: "start"; label: "开始处理" | "处理中" | "已开始" | "重试处理"; enabled: boolean }>
  | Readonly<{ kind: "review"; label: "查看并确认"; enabled: true; href: string }>
  | Readonly<{ kind: "progress"; label: "查看进度"; enabled: true; href: string }>
  | Readonly<{ kind: "record"; label: "查看记录"; enabled: true; href: string }>
  | Readonly<{ kind: "issue"; label: "查看原因" | "重试"; enabled: true; href: string }>;

export type ProductRowView = Readonly<{
  productId: string;
  revisionId: string;
  thumbnailUrl: string | null;
  title: string;
  sourceLabel: string;
  sourceUrl: string | null;
  collectedAtLabel: string;
  businessStage: ProductBusinessStage;
  businessStatusLabel: string;
  imageProgressLabel: string;
  issueLabel: string | null;
  nextAction: RowAction;
  canBatchStart: boolean;
  canBatchConfirm: boolean;
  canBatchRetry: boolean;
}>;

export function productBusinessStage(item: ProductPoolItemV1): ProductBusinessStage {
  return projectUiStage({
    miaoshouSource: item.miaoshouSource,
    automation: item.automation,
    assetArchive: item.assetArchive,
    listing: item.listing,
    canvas: item.canvas,
    approval: item.approval,
    miaoshouEdit: item.miaoshouEdit,
    hasUsableCanvasOutputs: item.usableCanvasOutputCount > 0
  }).label;
}

export function canStartProcessing(item: ProductPoolItemV1): boolean {
  return item.automation === "not_started" &&
    (item.miaoshouSource === "success" || item.miaoshouSource === "skipped_duplicate") &&
    item.canonicalSuccessDetailId !== null &&
    item.sourceImageCount > 0;
}

export function buildImageProgress(item: ProductPoolItemV1): string {
  return `主图 ${Math.min(item.usableCanvasOutputCount, 5)}/5`;
}

export function buildProductIssue(item: ProductPoolItemV1): string | null {
  if (item.canonicalSuccessDetailId === null) return "缺少妙手采集箱详情 ID，无法写回";
  if (item.sourceImageCount <= 0) return "妙手原始数据没有可用图片";
  if (item.canvas === "partial" && item.usableCanvasOutputCount <= 0) return "Canvas 没有返回可用图片";
  if (item.canvas === "failed") return "Canvas 生图失败，请查看原因或重试";
  if (item.miaoshouEdit === "result_unknown") return "妙手写回结果未知，需要人工对账";
  if (item.assetArchive === "failed") return "图片归档失败，请重试";
  if (item.listing === "failed" || item.listing === "needs_input") return "标题或 Listing 生成失败，请查看原因";
  if (item.approval === "invalidated") return "商品内容已修改，需要重新确认";
  if (item.miaoshouSource === "failed") return "妙手采集失败，请重新采集";
  return item.warningCodes[0] ?? null;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
}

export function buildProductRowView(item: ProductPoolItemV1, startStatus: StartStatus = "idle"): ProductRowView {
  const productId = String(item.productId);
  const stage = productBusinessStage(item);
  const issue = buildProductIssue(item);
  const href = `/products/${encodeURIComponent(productId)}`;
  const startable = canStartProcessing(item);
  const nextAction: RowAction =
    stage === "review"
      ? { kind: "review", label: "查看并确认", enabled: true, href }
      : stage === "processing"
        ? { kind: "progress", label: "查看进度", enabled: true, href }
        : stage === "synced"
          ? { kind: "record", label: "查看记录", enabled: true, href: `/write-records?productId=${encodeURIComponent(productId)}` }
          : stage === "needs_attention"
            ? { kind: "issue", label: issue?.includes("失败") ? "重试" : "查看原因", enabled: true, href }
            : { kind: "start", label: startStatus === "pending" ? "处理中" : startStatus === "success" ? "已开始" : startStatus === "failure" ? "重试处理" : "开始处理", enabled: startable && startStatus !== "pending" && startStatus !== "success" };

  return {
    productId,
    revisionId: String(item.currentRevisionId),
    thumbnailUrl: item.thumbnailUrl ?? null,
    title: item.targetTitle ?? item.canonicalSourceTitle ?? productId,
    sourceLabel: item.sourceItemId ? `1688 · ${String(item.sourceItemId)}` : "1688",
    sourceUrl: item.sourceUrl ?? null,
    collectedAtLabel: formatDate(item.collectedAt),
    businessStage: stage,
    businessStatusLabel: STAGE_LABELS[stage],
    imageProgressLabel: buildImageProgress(item),
    issueLabel: issue,
    nextAction,
    canBatchStart: stage === "pending" && startable,
    canBatchConfirm: stage === "review" && item.usableCanvasOutputCount > 0 && item.canonicalSuccessDetailId !== null,
    canBatchRetry: stage === "needs_attention"
  };
}
```

- [ ] **Step 4: Re-export stage types from selectors**

In `apps/web/src/components/products/product-workbench.selectors.ts`, import and re-export:

```ts
export {
  STAGE_ORDER,
  STAGE_LABELS,
  buildProductRowView,
  canStartProcessing as canStartAutomation,
  productBusinessStage as productStage,
  type WorkbenchStageKey as StageKey
} from "./product-row-view";
```

Keep the existing `buildAutomationProgress()`, `buildStageOverview()` and `applyStageFilter()` functions, but make them call `productBusinessStage()` and `STAGE_LABELS`.

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- product-row-view.test.ts product-workbench.projection.test.ts
pnpm --filter @tk/web typecheck
```

Expected: both tests and typecheck pass.

---

### Task 2: Enrich Product Pool Read Model For UI Fields

**Files:**
- Modify: `packages/contracts/src/read-models.ts`
- Modify: `apps/web/src/server/services/product-service.ts`
- Modify: `apps/web/src/lib/fixtures.ts`
- Modify: `apps/web/src/app/api/v1/api.integration.test.ts`
- Modify: `apps/web/src/app/products/page.test.tsx`
- Modify: `apps/web/src/components/products/product-workbench.projection.test.ts`
- Modify: `apps/web/src/components/products/product-table.test.tsx`

**Interfaces:**
- Consumes: `products.source_url`, `products.created_at`, `products.updated_at`, `product_revisions.source_payload.mainImages`, `product_revisions.source_payload.detailImages`
- Produces new `ProductPoolItemV1` fields:
  - `sourceUrl: string`
  - `thumbnailUrl: string | null`
  - `collectedAt: string`
  - `updatedAt: string`

- [ ] **Step 1: Add RED type expectations**

Update representative `ProductPoolItemV1` fixtures in tests with:

```ts
sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
thumbnailUrl: "https://img.test/main.jpg",
collectedAt: "2026-07-22T10:00:00.000Z",
updatedAt: "2026-07-22T10:10:00.000Z",
```

- [ ] **Step 2: Run typecheck to prove missing contract fields**

Run:

```bash
pnpm --filter @tk/contracts typecheck
pnpm --filter @tk/web typecheck
```

Expected before implementation: FAIL because `ProductPoolItemV1` does not define the new fields.

- [ ] **Step 3: Add contract fields**

In `packages/contracts/src/read-models.ts`, extend `ProductPoolItemV1` near source title:

```ts
  sourceUrl: string;
  thumbnailUrl: string | null;
  collectedAt: string;
  updatedAt: string;
```

- [ ] **Step 4: Project source URL, thumbnail and timestamps**

In `apps/web/src/server/services/product-service.ts`, update `PRODUCT_POOL_SQL`:

```sql
SELECT p.id AS product_id,
       revision.id AS current_revision_id,
       p.source_url,
       p.created_at AS collected_at,
       p.updated_at AS updated_at,
       p.source_item_id,
       revision.source_title AS canonical_source_title,
```

Add thumbnail projection:

```sql
       COALESCE(
         (
           SELECT image->>'url'
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(revision.source_payload->'mainImages') = 'array'
               THEN revision.source_payload->'mainImages'
               ELSE '[]'::jsonb
             END
           ) image
           WHERE image ? 'url'
           LIMIT 1
         ),
         (
           SELECT image->>'url'
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(revision.source_payload->'detailImages') = 'array'
               THEN revision.source_payload->'detailImages'
               ELSE '[]'::jsonb
             END
           ) image
           WHERE image ? 'url'
           LIMIT 1
         )
       ) AS thumbnail_url,
```

Map in `toPoolItem()`:

```ts
    sourceUrl: requiredString(row, "source_url"),
    thumbnailUrl: optionalString(row, "thumbnail_url"),
    collectedAt: row.collected_at instanceof Date ? row.collected_at.toISOString() : requiredString(row, "collected_at"),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : requiredString(row, "updated_at"),
```

- [ ] **Step 5: Add service test for Miaoshou image payload shape**

In `apps/web/src/app/final-review.test.tsx`, extend the existing `ProductService` projection test or add a focused test:

```ts
it("projects thumbnail and timestamps for the product workbench list", async () => {
  const service = new ProductService({ query: vi.fn().mockResolvedValue({ rows: [{
    product_id: "product-13",
    current_revision_id: "revision-13",
    source_url: "https://detail.1688.com/offer/1013001591920.html",
    collected_at: new Date("2026-07-22T10:00:00.000Z"),
    updated_at: new Date("2026-07-22T10:10:00.000Z"),
    source_item_id: "1013001591920",
    canonical_source_title: "真实妙手商品",
    target_title: null,
    canonical_success_detail_id: "detail-13",
    locale: "th-TH",
    currency: "THB",
    price_minor: null,
    source_image_count: 2,
    image_count: 0,
    canvas_outputs: [],
    state_source: "success",
    state_automation: "not_started",
    state_asset_archive: "pending",
    state_listing: "pending",
    state_canvas: "not_started",
    state_approval: "unapproved",
    state_miaoshou_edit: "not_started",
    warning_codes: [],
    thumbnail_url: "https://source.test/main.jpg"
  }] }) });
  const projected = await service.list();
  expect(projected.items[0]).toMatchObject({
    sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
    thumbnailUrl: "https://source.test/main.jpg",
    collectedAt: "2026-07-22T10:00:00.000Z"
  });
});
```

- [ ] **Step 6: Run focused verification**

Run:

```bash
pnpm --filter @tk/contracts typecheck
pnpm --filter @tk/web test -- final-review.test.tsx product-workbench.projection.test.ts product-table.test.tsx
pnpm --filter @tk/web typecheck
```

Expected: all pass.

---

### Task 3: Primary Navigation And Route Boundaries

**Files:**
- Modify: `apps/web/src/components/navigation/sidebar.tsx`
- Create: `apps/web/src/app/processing-rules/page.tsx`
- Modify: `apps/web/src/app/templates/page.tsx`
- Create: `apps/web/src/app/write-records/page.tsx`
- Modify: `apps/web/src/app/final-review.test.tsx`

**Interfaces:**
- Produces primary nav items:
  - `/` → 商品
  - `/processing-rules` → 处理规则
  - `/write-records` → 写入记录
  - `/settings` → 设置
- Keeps `/tasks` reachable only from settings diagnostics.
- Keeps `/templates` compatible by redirecting to `/processing-rules`.

- [ ] **Step 1: Update navigation RED test**

In `apps/web/src/app/final-review.test.tsx`, replace the old “Wave 3 work areas” navigation test with:

```ts
it("shows only the approved primary navigation items", () => {
  const html = renderToStaticMarkup(<Sidebar />);
  expect(html).toContain("href=\"/\"");
  expect(html).toContain("商品");
  expect(html).toContain("href=\"/processing-rules\"");
  expect(html).toContain("处理规则");
  expect(html).toContain("href=\"/write-records\"");
  expect(html).toContain("写入记录");
  expect(html).toContain("href=\"/settings\"");
  expect(html).toContain("设置");
  expect(html).not.toContain("任务中心");
  expect(html).not.toContain("模板库");
});
```

- [ ] **Step 2: Run RED test**

Run:

```bash
pnpm --filter @tk/web test -- final-review.test.tsx
```

Expected before implementation: FAIL because sidebar still shows `/tasks` and `/templates`.

- [ ] **Step 3: Update sidebar**

In `apps/web/src/components/navigation/sidebar.tsx`, change `ITEMS`:

```ts
const ITEMS: ReadonlyArray<SidebarItem> = [
  { href: "/", label: "商品", ariaLabel: "商品处理台" },
  { href: "/processing-rules", label: "处理规则", ariaLabel: "处理规则" },
  { href: "/write-records", label: "写入记录", ariaLabel: "妙手写入记录" },
  { href: "/settings", label: "设置", ariaLabel: "工作区设置" }
];
```

- [ ] **Step 4: Add lightweight processing rules page**

Create `apps/web/src/app/processing-rules/page.tsx`:

```tsx
export const dynamic = "force-dynamic";

export function renderProcessingRulesPage() {
  return (
    <section aria-label="处理规则">
      <header className="tk-page-heading">
        <div><p>Rules</p><h1>处理规则</h1></div>
      </header>
      <div className="tk-panel">
        <h2>标题规则</h2>
        <p>用于控制标题清洗、目标语言风格、禁词和保留词。商品属性以妙手采集结果为准，本地只做翻译、清洗、格式校验和缺失提示。</p>
        <dl>
          <div><dt>默认目标语言</dt><dd>th-TH，可在设置页改为自定义 BCP-47 语言代码。</dd></div>
          <div><dt>标题风格</dt><dd>电商转化、简洁、高端。</dd></div>
          <div><dt>禁词/保留词</dt><dd>本期先展示规则说明，持久化编辑放入后续增强。</dd></div>
        </dl>
      </div>
      <div className="tk-panel">
        <h2>Canvas 工作流</h2>
        <p>当前绑定 Canvas 画布 TK 的 `TK工作流`：最多输入 9 张图，期望输出 5 张图。产品识别和风格由 Canvas 工作流内部处理。</p>
      </div>
    </section>
  );
}

export default function ProcessingRulesPage() {
  return renderProcessingRulesPage();
}
```

- [ ] **Step 5: Keep templates route compatible**

In `apps/web/src/app/templates/page.tsx`, replace template manager rendering with a redirect:

```tsx
import { redirect } from "next/navigation";

export default function TemplatesPage() {
  redirect("/processing-rules");
}
```

If tests import `renderTemplatesPage`, keep a named compatibility export:

```tsx
export { renderProcessingRulesPage as renderTemplatesPage } from "../processing-rules/page";
```

- [ ] **Step 6: Add write-records page skeleton**

Create `apps/web/src/app/write-records/page.tsx`:

```tsx
export const dynamic = "force-dynamic";

export function renderWriteRecordsPage() {
  return (
    <section aria-label="写入记录">
      <header className="tk-page-heading">
        <div><p>Miaoshou</p><h1>写入记录</h1></div>
      </header>
      <p>这里展示确认后写回妙手 canonical 公共采集箱商品的记录，不展示 TikTok 发布入口。</p>
    </section>
  );
}

export default function WriteRecordsPage() {
  return renderWriteRecordsPage();
}
```

- [ ] **Step 7: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- final-review.test.tsx
pnpm --filter @tk/web typecheck
```

Expected: navigation tests pass and `/templates` compatibility imports still typecheck.

---

### Task 4: Product Workbench Table, Tabs And Batch Bar

**Files:**
- Modify: `apps/web/src/components/products/product-workbench.state.ts`
- Modify: `apps/web/src/components/products/product-workbench.tsx`
- Modify: `apps/web/src/components/products/product-table.tsx`
- Modify: `apps/web/src/components/products/stage-overview.tsx`
- Modify: `apps/web/src/components/products/product-workbench.state.test.ts`
- Modify: `apps/web/src/components/products/product-table.test.tsx`

**Interfaces:**
- Consumes: `ProductRowView`
- Produces:
  - `selectedBatchStartIds(s): string[]`
  - `selectedBatchConfirmIds(s): string[]`
  - `selectedBatchRetryIds(s): string[]`
  - Table image and `查看` link point to `/products/{productId}`.

- [ ] **Step 1: Update state tests for three batch groups**

In `apps/web/src/components/products/product-workbench.state.test.ts`, add:

```ts
it("derives separate batch groups for start, confirm and retry", () => {
  const pending = makeItem("pending", { sourceImageCount: 6 });
  const review = makeItem("review", {
    automation: "ready",
    assetArchive: "ready",
    listing: "ready",
    canvas: "succeeded",
    usableCanvasOutputCount: 5
  });
  const failed = makeItem("failed", { canvas: "failed" });
  let state = createWorkbenchState([pending, review, failed]);
  state = toggleSelection(state, "pending");
  state = toggleSelection(state, "review");
  state = toggleSelection(state, "failed");

  expect(state.batchStartCount).toBe(1);
  expect(state.batchConfirmCount).toBe(1);
  expect(state.batchRetryCount).toBe(1);
  expect(selectedBatchStartIds(state)).toEqual(["pending"]);
  expect(selectedBatchConfirmIds(state)).toEqual(["review"]);
  expect(selectedBatchRetryIds(state)).toEqual(["failed"]);
});
```

Use the existing fixture helper name in that file. If it is named `item`, use `item()` instead of `makeItem()`.

- [ ] **Step 2: Run RED state test**

Run:

```bash
pnpm --filter @tk/web test -- product-workbench.state.test.ts
```

Expected before implementation: FAIL because batch confirm/retry counts do not exist.

- [ ] **Step 3: Extend WorkbenchState**

In `apps/web/src/components/products/product-workbench.state.ts`, add fields:

```ts
  batchStartLabel: string;
  batchStartEnabled: boolean;
  batchStartCount: number;
  batchConfirmLabel: string;
  batchConfirmEnabled: boolean;
  batchConfirmCount: number;
  batchRetryLabel: string;
  batchRetryEnabled: boolean;
  batchRetryCount: number;
```

In `derive()`, compute views:

```ts
const selectedItems = s.items.filter((item) => s.selectedIds.has(String(item.productId)));
const selectedViews = selectedItems.map((item) => buildProductRowView(item, s.startStatusById.get(String(item.productId)) ?? "idle"));
const startCount = selectedViews.filter((view) => view.canBatchStart).length;
const confirmCount = selectedViews.filter((view) => view.canBatchConfirm).length;
const retryCount = selectedViews.filter((view) => view.canBatchRetry).length;
```

Return:

```ts
batchStartLabel: `批量开始处理（${startCount}）`,
batchStartEnabled: startCount > 0,
batchStartCount: startCount,
batchConfirmLabel: `批量确认写回（${confirmCount}）`,
batchConfirmEnabled: confirmCount > 0,
batchConfirmCount: confirmCount,
batchRetryLabel: `批量重试（${retryCount}）`,
batchRetryEnabled: retryCount > 0,
batchRetryCount: retryCount,
```

Keep old `batchButtonLabel` and `batchButtonEnabled` as aliases during this task if existing tests still assert them:

```ts
batchButtonLabel: `批量开始处理（${startCount}）`,
batchButtonEnabled: startCount > 0,
```

- [ ] **Step 4: Add selector exports**

In `product-workbench.state.ts`:

```ts
export function selectedBatchStartIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchStart ? [id] : [];
  });
}

export function selectedBatchConfirmIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchConfirm ? [id] : [];
  });
}

export function selectedBatchRetryIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchRetry ? [id] : [];
  });
}
```

- [ ] **Step 5: Update ProductTable test**

In `product-table.test.tsx`, add an assertion that image and View open the same details page:

```ts
it("opens the product detail image review page from image and View action", () => {
  const { screen } = renderTable({ item: item({ thumbnailUrl: "https://img.test/main.jpg" }) });
  expect(screen.getByRole("link", { name: /查看商品图片 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
  expect(screen.getByRole("link", { name: /查看并确认 892408514788|查看详情 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
});
```

- [ ] **Step 6: Rewrite table columns**

In `apps/web/src/components/products/product-table.tsx`, derive `row = buildProductRowView(item, startStatus)` inside map and render columns:

```tsx
<th scope="col">选择</th>
<th scope="col">商品</th>
<th scope="col">来源</th>
<th scope="col">采集时间</th>
<th scope="col">业务状态</th>
<th scope="col">图片进度</th>
<th scope="col">问题</th>
<th scope="col">下一步</th>
<th scope="col">操作</th>
```

For the image/title cell:

```tsx
<a href={`/products/${encodeURIComponent(row.productId)}`} aria-label={`查看商品图片 ${row.productId}`} className="tk-product-table__product">
  {row.thumbnailUrl ? <img src={row.thumbnailUrl} alt="" loading="lazy" /> : <span className="tk-product-table__thumb-empty">无图</span>}
  <span>{row.title}</span>
</a>
```

For next action:

```tsx
{row.nextAction.kind === "start" ? (
  <button type="button" aria-label={`${row.nextAction.label} ${row.productId}`} disabled={!row.nextAction.enabled} onClick={() => onStart(row.productId)}>
    {row.nextAction.label}
  </button>
) : (
  <a href={row.nextAction.href} aria-label={`${row.nextAction.label} ${row.productId}`}>{row.nextAction.label}</a>
)}
```

- [ ] **Step 7: Update ProductWorkbench batch footer**

In `product-workbench.tsx`, render three buttons:

```tsx
<button type="button" aria-label={state.batchStartLabel} disabled={!state.batchStartEnabled} onClick={handleBatchStart}>
  {state.batchStartLabel}
</button>
<button type="button" aria-label={state.batchConfirmLabel} disabled={!state.batchConfirmEnabled} onClick={handleBatchConfirm}>
  {state.batchConfirmLabel}
</button>
<button type="button" aria-label={state.batchRetryLabel} disabled={!state.batchRetryEnabled} onClick={handleBatchRetry}>
  {state.batchRetryLabel}
</button>
```

For this task, `handleBatchConfirm` and `handleBatchRetry` may call `apiClient.send("BatchProductActionV1", ...)` only after Task 8 creates the endpoint. Until then, implement them as disabled through state if the endpoint is not wired in the same branch. If this task and Task 8 are implemented in parallel, keep handlers behind injected callbacks:

```ts
onBatchConfirm?: (productIds: ReadonlyArray<string>) => void;
onBatchRetry?: (productIds: ReadonlyArray<string>) => void;
```

- [ ] **Step 8: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- product-workbench.state.test.ts product-table.test.tsx product-workbench.projection.test.ts
pnpm --filter @tk/web typecheck
```

Expected: all pass.

---

### Task 5: Product Detail / Image Confirmation Page

**Files:**
- Modify: `apps/web/src/app/products/[productId]/page.tsx`
- Modify: `apps/web/src/app/products/[productId]/review/page.tsx`
- Modify: `apps/web/src/components/review/final-review.tsx`
- Modify: `apps/web/src/components/review/approval-actions.tsx`
- Modify: `apps/web/src/app/products/[productId]/page.test.tsx`
- Modify: `apps/web/src/app/final-review.test.tsx`

**Interfaces:**
- `/products/{productId}` is the canonical 商品详情 / 图片确认页.
- `/products/{productId}/review` remains compatible and renders the same review workspace.
- The main external write button text is `确认写回妙手`.

- [ ] **Step 1: Update detail page test**

In `apps/web/src/app/products/[productId]/page.test.tsx`, replace the “go back to workbench” assertion with:

```ts
it("renders the product detail image confirmation workspace", async () => {
  const html = renderToStaticMarkup(await renderProductPage(
    Promise.resolve({ productId: "database-product" }),
    {
      get: async () => workspace,
      preview: async () => ({
        productId: workspace.productId,
        draftVersion: workspace.draftVersion,
        listingRunId: "listing-1",
        pricingRunId: "pricing-1",
        templateVersion: 1,
        orderedFinalAssetIds: workspace.finalAssetOrder,
        locale: "th-TH",
        currency: "THB",
        finalPriceWire: null,
        warningCodes: [],
        miaoshouTargetDetailId: "detail-1" as never
      }),
      facts: async () => ({
        skuCount: 2,
        orderedFinalImages: [{ assetId: "asset-1", previewUrl: "https://img.test/final.jpg" }],
        stock: "10",
        weightKg: "0.50",
        dimensions: null,
        canonicalMiaoshouTarget: "detail-1"
      })
    }
  ));
  expect(html).toContain("商品详情 / 图片确认");
  expect(html).toContain("图片确认");
  expect(html).toContain("检查结果");
  expect(html).toContain("确认写回妙手");
  expect(html).not.toContain("请回到");
});
```

Use the existing `workspace` fixture from the file or copy the fixture shape from `final-review.test.tsx`.

- [ ] **Step 2: Run RED test**

Run:

```bash
pnpm --filter @tk/web test -- 'products/[productId]/page.test.tsx'
```

Expected before implementation: FAIL because detail page is still a summary page.

- [ ] **Step 3: Share renderer with review page**

In `apps/web/src/app/products/[productId]/page.tsx`, import `FinalReview` and use the same reader shape as review page:

```tsx
import type { ApprovalPreviewV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "../../../components/review/review-workspace-view";
import { FinalReview } from "../../../components/review/final-review";
import { getServerServices } from "../../../server/composition";

type ProductReader = {
  get(productId: string): Promise<ProductWorkspaceV1 | null>;
  preview?(productId: string): Promise<ApprovalPreviewV1 | null>;
  facts(productId: string): Promise<ReviewWorkspaceView["reviewFacts"]>;
};

export async function renderProductPage(params: PageProps["params"], products: ProductReader) {
  const { productId } = await params;
  const [workspace, approvalPreview, reviewFacts] = await Promise.all([
    products.get(productId),
    products.preview?.(productId) ?? Promise.resolve(null),
    products.facts(productId)
  ]);
  if (!workspace) return <article aria-label={`未找到商品 ${productId}`}><h1>未找到商品 {productId}</h1></article>;
  return <FinalReview workspace={{ ...workspace, reviewFacts }} approvalPreview={approvalPreview} />;
}
```

In `/products/[productId]/review/page.tsx`, re-export or call this renderer:

```tsx
export { renderProductPage as renderReviewPage } from "../page";
```

If relative import is awkward, keep a small wrapper but ensure output matches `/products/{id}`.

- [ ] **Step 4: Adjust FinalReview layout and copy**

In `apps/web/src/components/review/final-review.tsx`, change heading:

```tsx
<div><p>商品详情 / 图片确认 · v{workspace.draftVersion}</p><h1>{workspace.target?.title ?? workspace.originalListing?.sourceTitle ?? workspace.productId}</h1></div>
```

Wrap sections:

```tsx
<div className="tk-review__workspace">
  <section aria-label="图片确认" className="tk-review__images">...</section>
  <section aria-label="商品内容" className="tk-review__content">...</section>
  <aside aria-label="检查结果和下一步" className="tk-review__decision">...</aside>
</div>
```

Move `FinalImageOrder` into the left area, listing/pricing/facts into the center, warnings and `ApprovalActions` into the right area. Keep component imports unchanged.

- [ ] **Step 5: Rename confirm button**

In `apps/web/src/components/review/approval-actions.tsx`, set the external-write button text to:

```tsx
确认写回妙手
```

Keep safety copy:

```tsx
<p>确认只会编辑妙手中已采集的同一商品，不会触发店铺发布。</p>
```

- [ ] **Step 6: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- 'products/[productId]/page.test.tsx' final-review.test.tsx
pnpm --filter @tk/web typecheck
```

Expected: detail/review tests pass and no TikTok publish text appears.

---

### Task 6: Settings Diagnostics And Processing Rules Boundary

**Files:**
- Create: `apps/web/src/components/settings/sections/system-diagnostics-section.tsx`
- Modify: `apps/web/src/components/settings/settings-workspace.tsx`
- Modify: `apps/web/src/components/settings/sections/provider-options-section.tsx`
- Modify: `apps/web/src/components/settings/__tests__/settings-workspace.test.tsx`
- Modify: `apps/web/src/components/settings/__tests__/sections.test.tsx`
- Modify: `apps/web/src/app/final-review.test.tsx`

**Interfaces:**
- Settings shows:
  - 妙手连接与写回模式
  - Canvas 地址/`TK工作流` 运行说明
  - LLM 配置状态
  - 默认目标语言
  - 定价公式
  - 系统诊断 / 任务日志入口
- Settings does not show editable Canvas reference image or visual style.

- [ ] **Step 1: Add tests for settings boundary**

In `settings-workspace.test.tsx`, add:

```tsx
it("exposes task logs through system diagnostics instead of primary navigation", () => {
  const { getByRole, queryByText } = render(<SettingsWorkspace initial={settings} />);
  expect(getByRole("region", { name: "系统诊断" })).toBeInTheDocument();
  expect(getByRole("link", { name: "打开任务日志" })).toHaveAttribute("href", "/tasks");
  expect(queryByText("参考图")).not.toBeInTheDocument();
  expect(queryByText("生图风格")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run RED settings test**

Run:

```bash
pnpm --filter @tk/web test -- settings-workspace.test.tsx sections.test.tsx
```

Expected before implementation: FAIL because `系统诊断` section does not exist or provider copy is still template-like.

- [ ] **Step 3: Create diagnostics section**

Create `apps/web/src/components/settings/sections/system-diagnostics-section.tsx`:

```tsx
import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export function SystemDiagnosticsSection({ draft }: { draft: WorkspaceSettingsView }) {
  return (
    <section aria-label="系统诊断">
      <p>任务中心已从主导航移除。这里用于排查后台任务、失败恢复和日志追踪。</p>
      <a className="tk-button tk-button--secondary" href="/tasks" aria-label="打开任务日志">打开任务日志</a>
      <dl>
        <div><dt>运行模式</dt><dd>{draft.externalAdapterMode}</dd></div>
        <div><dt>Canvas</dt><dd>{draft.secretStatus.canvasConfigured ? "已配置" : "未配置"} · TK工作流</dd></div>
        <div><dt>妙手</dt><dd>{draft.secretStatus.miaoshouConfigured ? "已配置" : "未配置"}</dd></div>
        <div><dt>LLM</dt><dd>{draft.secretStatus.llmConfigured ? "已配置" : "未配置"}</dd></div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Mount diagnostics card**

In `settings-workspace.tsx`, import and add:

```tsx
<SettingsCard title="系统诊断" hint="任务日志、运行边界和失败排查入口" ariaLabel="系统诊断">
  <SystemDiagnosticsSection draft={draft} />
</SettingsCard>
```

- [ ] **Step 5: Replace misleading provider copy**

In `provider-options-section.tsx`, use non-misleading copy:

```tsx
<p>Canvas 当前运行工作流为 TK工作流。此页面显示工作区默认值；Worker 实际运行依赖启动配置，修改后需要确认 Worker 是否重启并读取最新配置。</p>
```

Remove references to reference images and visual style from this section.

- [ ] **Step 6: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- settings-workspace.test.tsx sections.test.tsx final-review.test.tsx
pnpm --filter @tk/web typecheck
```

Expected: settings tests pass, no primary nav task center, diagnostics link exists.

---

### Task 7: Write Records Page Backed By Miaoshou Syncs

**Files:**
- Create: `apps/web/src/server/services/miaoshou-sync-service.ts`
- Modify: `apps/web/src/server/composition.ts`
- Modify: `apps/web/src/app/api/v1/miaoshou-syncs/route.ts`
- Modify: `apps/web/src/app/write-records/page.tsx`
- Create: `apps/web/src/app/write-records/page.test.tsx`
- Modify: `apps/web/src/app/product-safety.test.tsx`

**Interfaces:**
- Produces `MiaoshouSyncService.list(): Promise<{ items: MiaoshouSyncStatusV1[] }>`
- `/write-records` renders sync ID, approval snapshot ID, state, remote detail ID, last reconciled time and safe error message.

- [ ] **Step 1: Add write records page test**

Create `apps/web/src/app/write-records/page.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderWriteRecordsPage } from "./page";

describe("write records page", () => {
  it("renders Miaoshou write records without TikTok publish actions", () => {
    const html = renderToStaticMarkup(renderWriteRecordsPage({
      items: [{
        syncId: "sync-1",
        approvalSnapshotId: "approval-1",
        state: "succeeded",
        remoteDetailId: "3814610360" as never,
        lastReconciledAt: "2026-07-22T10:00:00.000Z",
        error: null
      }]
    }));
    expect(html).toContain("写入记录");
    expect(html).toContain("3814610360");
    expect(html).toContain("succeeded");
    expect(html).not.toContain("发布 TikTok");
  });
});
```

- [ ] **Step 2: Run RED test**

Run:

```bash
pnpm --filter @tk/web test -- write-records/page.test.tsx
```

Expected before implementation: FAIL because page does not accept data.

- [ ] **Step 3: Create sync service**

Create `apps/web/src/server/services/miaoshou-sync-service.ts`:

```ts
import { miaoshouDetailId } from "@tk/contracts/ids";
import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";
import type { QueryPort } from "./product-service";

export class MiaoshouSyncService {
  constructor(private readonly database: QueryPort) {}

  async list(): Promise<{ items: MiaoshouSyncStatusV1[] }> {
    const result = await this.database.query(
      `SELECT id, approval_snapshot_id, state, remote_detail_id, last_reconciled_at, error
       FROM miaoshou_syncs ORDER BY updated_at DESC, created_at DESC`
    );
    return {
      items: result.rows.map((row) => ({
        syncId: String(row.id),
        approvalSnapshotId: String(row.approval_snapshot_id),
        state: String(row.state) as MiaoshouSyncStatusV1["state"],
        remoteDetailId: typeof row.remote_detail_id === "string" ? miaoshouDetailId(row.remote_detail_id) : null,
        lastReconciledAt: row.last_reconciled_at instanceof Date ? row.last_reconciled_at.toISOString() : null,
        error: row.error as MiaoshouSyncStatusV1["error"]
      }))
    };
  }
}
```

- [ ] **Step 4: Wire service into composition and API**

In `server/composition.ts`, add:

```ts
import { MiaoshouSyncService } from "./services/miaoshou-sync-service";
```

Extend `ServerServices`:

```ts
syncs: MiaoshouSyncService;
```

Return:

```ts
syncs: new MiaoshouSyncService(database),
```

In `api/v1/miaoshou-syncs/route.ts`, use server services:

```ts
export async function GET(request: Request): Promise<Response> {
  const rejected = rejectNonLoopback(request);
  if (rejected) return rejected;
  const { getServerServices } = await import("../../../../server/composition");
  return Response.json(await (await getServerServices()).syncs.list());
}
```

Keep `createGetHandler()` exported for tests.

- [ ] **Step 5: Render records page**

In `apps/web/src/app/write-records/page.tsx`:

```tsx
import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

export function renderWriteRecordsPage(data: { items: MiaoshouSyncStatusV1[] }) {
  return (
    <section aria-label="写入记录">
      <header className="tk-page-heading">
        <div><p>Miaoshou</p><h1>写入记录</h1></div>
      </header>
      <p>这里展示确认后写回妙手 canonical 公共采集箱商品的记录，不展示 TikTok 发布入口。</p>
      <table>
        <thead><tr><th>同步 ID</th><th>审批快照</th><th>状态</th><th>妙手详情 ID</th><th>最近对账</th><th>错误</th></tr></thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.syncId}>
              <td>{item.syncId}</td>
              <td>{item.approvalSnapshotId}</td>
              <td>{item.state}</td>
              <td>{item.remoteDetailId ?? "—"}</td>
              <td>{item.lastReconciledAt ?? "—"}</td>
              <td>{item.error?.safeMessage ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function WriteRecordsPage() {
  return renderWriteRecordsPage(await (await getServerServices()).syncs.list());
}
```

- [ ] **Step 6: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- write-records/page.test.tsx product-safety.test.tsx
pnpm --filter @tk/web typecheck
```

Expected: page and API both pass safety checks.

---

### Task 8: Controlled Batch Confirm And Batch Retry

**Files:**
- Create: `apps/web/src/server/services/product-rerun-service.ts`
- Modify: `apps/web/src/server/composition.ts`
- Create: `apps/web/src/app/api/v1/products/batch-actions/route.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Modify: `apps/web/src/components/products/product-workbench.tsx`
- Create: `apps/web/src/app/api/v1/products/batch-actions/route.test.ts`
- Modify: `apps/web/src/components/products/product-workbench.command.test.ts`

**Interfaces:**
- Consumes selected product IDs from `selectedBatchConfirmIds()` and `selectedBatchRetryIds()`.
- Produces:
  - `POST /api/v1/products/batch-actions`
  - Request body: `{ action: "confirm_miaoshou_edit" | "retry_from_failure"; productIds: string[] }`
  - Response body: `{ results: Array<{ productId: string; ok: boolean; code?: string }> }`
- Does not expose TikTok publish.
- Does not confirm products that are not in current `review` stage.

- [ ] **Step 1: Add route tests**

Create `apps/web/src/app/api/v1/products/batch-actions/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPostHandler } from "./route";

function request(body: unknown) {
  return new Request("http://127.0.0.1/api/v1/products/batch-actions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body)
  });
}

describe("batch product actions", () => {
  it("confirms only review-ready products using server-side preview snapshots", async () => {
    const confirmAndEnqueue = vi.fn().mockResolvedValue({ approvalSnapshotId: "approval-1", syncId: "sync-1" });
    const response = await createPostHandler({
      products: {
        preview: vi.fn().mockResolvedValue({
          productId: "product-1",
          draftVersion: 4,
          listingRunId: "listing-1",
          pricingRunId: "pricing-1",
          templateVersion: 3,
          orderedFinalAssetIds: ["asset-1"],
          locale: "th-TH",
          currency: "THB",
          finalPriceWire: { amountMinor: "10000", currency: "THB" },
          warningCodes: [],
          miaoshouTargetDetailId: "detail-1"
        })
      },
      approvals: { confirmAndEnqueue },
      reruns: { enqueueProductRetry: vi.fn() }
    })(request({ action: "confirm_miaoshou_edit", productIds: ["product-1"] }));
    expect(response.status).toBe(202);
    expect(confirmAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      productId: "product-1",
      expectedListingRunId: "listing-1",
      orderedFinalAssetIds: ["asset-1"]
    }));
  });

  it("rejects empty product id arrays", async () => {
    const response = await createPostHandler({
      products: { preview: vi.fn() },
      approvals: { confirmAndEnqueue: vi.fn() },
      reruns: { enqueueProductRetry: vi.fn() }
    })(request({ action: "confirm_miaoshou_edit", productIds: [] }));
    expect(response.status).toBe(400);
  });

  it("routes batch retry through the product retry port", async () => {
    const enqueueProductRetry = vi.fn().mockResolvedValue(undefined);
    const response = await createPostHandler({
      products: { preview: vi.fn() },
      approvals: { confirmAndEnqueue: vi.fn() },
      reruns: { enqueueProductRetry }
    })(request({ action: "retry_from_failure", productIds: ["product-1"] }));
    expect(response.status).toBe(202);
    expect(enqueueProductRetry).toHaveBeenCalledWith("product-1");
  });
});
```

- [ ] **Step 2: Run RED route test**

Run:

```bash
pnpm --filter @tk/web test -- batch-actions/route.test.ts
```

Expected before implementation: FAIL because route does not exist.

- [ ] **Step 3: Implement batch route**

Create `apps/web/src/app/api/v1/products/batch-actions/route.ts`:

```ts
import { z } from "zod";
import type { ConfirmMiaoshouEditV1 as ConfirmCommand } from "@tk/contracts";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../server/auth/loopback";

const BatchActionRequest = z.object({
  action: z.enum(["confirm_miaoshou_edit", "retry_from_failure"]),
  productIds: z.array(z.string().min(1)).min(1).max(50)
});

type ProductPreviewPort = {
  preview(productId: string): Promise<{
    productId: string;
    draftVersion: number;
    listingRunId: string;
    pricingRunId: string;
    templateVersion: number;
    orderedFinalAssetIds: readonly string[];
  } | null>;
};

type ApprovalPort = { confirmAndEnqueue(command: ConfirmCommand): Promise<{ approvalSnapshotId: string; syncId: string }> };
type RerunPort = { enqueueProductRetry(productId: string): Promise<void> };

export function createPostHandler(dependencies: { products: ProductPreviewPort; approvals: ApprovalPort; reruns: RerunPort }) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;
    const parsed = BatchActionRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    const results = [];
    for (const productId of parsed.data.productIds) {
      try {
        if (parsed.data.action === "confirm_miaoshou_edit") {
          const preview = await dependencies.products.preview(productId);
          if (!preview || preview.orderedFinalAssetIds.length === 0) throw Object.assign(new Error("approval_mapping_not_ready"), { code: "approval_mapping_not_ready" });
          await dependencies.approvals.confirmAndEnqueue({
            version: 1,
            productId,
            expectedDraftVersion: preview.draftVersion,
            expectedListingRunId: preview.listingRunId,
            expectedPricingRunId: preview.pricingRunId,
            expectedTemplateVersion: preview.templateVersion,
            orderedFinalAssetIds: preview.orderedFinalAssetIds.map(String)
          });
        } else {
          await dependencies.reruns.enqueueProductRetry(productId);
        }
        results.push({ productId, ok: true });
      } catch (error) {
        results.push({ productId, ok: false, code: (error as { code?: string }).code ?? "batch_action_failed" });
      }
    }
    return Response.json({ results }, { status: 202 });
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../../server/composition");
  const services = await getServerServices();
  return createPostHandler({
    products: services.products,
    approvals: services.approvals,
    reruns: services.productReruns
  })(request);
}
```

- [ ] **Step 4: Add product-level retry service**

Create `apps/web/src/server/services/product-rerun-service.ts`:

```ts
import type { RerunDownstreamV1 } from "@tk/contracts";
import type { ProductPoolItemV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";

type ProductReader = {
  list(): Promise<{ items: ProductPoolItemV1[] }>;
  get(productId: string): Promise<ProductWorkspaceV1 | null>;
};

type RerunCommandPort = {
  enqueue(command: RerunDownstreamV1, productId: string): Promise<unknown>;
};

function retryStartNode(item: ProductPoolItemV1): RerunDownstreamV1["startNode"] | null {
  if (item.listing === "failed" || item.listing === "needs_input") return "listing";
  if (item.canvas === "failed" || (item.canvas === "partial" && item.usableCanvasOutputCount === 0)) return "canvas";
  return null;
}

export class ProductRerunService {
  constructor(private readonly products: ProductReader, private readonly reruns: RerunCommandPort) {}

  async enqueueProductRetry(productId: string): Promise<void> {
    const [pool, workspace] = await Promise.all([
      this.products.list(),
      this.products.get(productId)
    ]);
    const item = pool.items.find((candidate) => String(candidate.productId) === productId);
    if (!item || !workspace) throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });
    const startNode = retryStartNode(item);
    if (!startNode) throw Object.assign(new Error("product_retry_not_available"), { code: "product_retry_not_available" });
    await this.reruns.enqueue({
      version: 1,
      revisionId: String(workspace.revisionId),
      expectedDraftVersion: workspace.draftVersion,
      startNode
    }, productId);
  }
}
```

Move or export the existing `createPgRerunPort()` used by `apps/web/src/app/api/v1/products/[productId]/rerun/route.ts` so `composition.ts` can construct one shared product rerun port. The implementation must not retry arbitrary rows from `jobs`; product retry must preserve product context and use `RerunDownstreamV1`.

- [ ] **Step 5: Wire product reruns into composition**

In `apps/web/src/server/composition.ts`, add:

```ts
import { ProductRerunService } from "./services/product-rerun-service";
```

Extend `ServerServices`:

```ts
productReruns: ProductRerunService;
```

When constructing services, assign `ProductService` to a variable so both routes can reuse it:

```ts
const productsService = new ProductService(database);
```

Return:

```ts
products: productsService,
productReruns: new ProductRerunService(productsService, pgRerunPort),
```

- [ ] **Step 6: Add API client helper**

In `apps/web/src/lib/api-client.ts`, add:

```ts
export async function dispatchBatchProductAction(
  fetcher: typeof fetch,
  body: { action: "confirm_miaoshou_edit" | "retry_from_failure"; productIds: readonly string[] }
): Promise<{ results: Array<{ productId: string; ok: boolean; code?: string }> }> {
  const response = await fetcher("/api/v1/products/batch-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as { results?: Array<{ productId: string; ok: boolean; code?: string }>; error?: string };
  if (!response.ok || !Array.isArray(result.results)) throw new Error(result.error ?? "batch_product_action_failed");
  return { results: result.results };
}
```

- [ ] **Step 7: Wire workbench buttons**

In `product-workbench.tsx`, implement:

```ts
const handleBatchConfirm = useCallback(() => {
  const productIds = selectedBatchConfirmIds(state);
  if (productIds.length === 0) return;
  void dispatchBatchProductAction(fetch, { action: "confirm_miaoshou_edit", productIds });
}, [state]);

const handleBatchRetry = useCallback(() => {
  const productIds = selectedBatchRetryIds(state);
  if (productIds.length === 0) return;
  void dispatchBatchProductAction(fetch, { action: "retry_from_failure", productIds });
}, [state]);
```

If `fetch` injection is needed for tests, add `batchActionFetcher?: typeof fetch` to `ProductWorkbench` props.

- [ ] **Step 8: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- batch-actions/route.test.ts product-workbench.command.test.ts
pnpm --filter @tk/web typecheck
```

Expected: route validates body, batch confirm uses server-side preview, no TikTok publish action exists.

---

### Task 9: Fixed Sample Acceptance And E2E Coverage

**Files:**
- Create: `e2e/workbench-fixed-samples.spec.ts`
- Modify: `e2e/browser-workbench.spec.ts`
- Modify: `docs/superpowers/reports/2026-07-22-workbench-experience-repair-verification.md`
- Modify: `.sdd/progress.md`

**Interfaces:**
- Gate 5 samples:
  - `https://detail.1688.com/offer/1013001591920.html?spm=a26352.13672862.offerlist.74.64241e62GBUfEO&cosite=-&tracelog=p4p&_p_isad=1&clickid=d609322de4c446eb9c7ad5f32c7264ef&sessionid=79d7417242becda81904b0b6debcf258`
  - `https://detail.1688.com/offer/892408514788.html`
  - `https://s.1688.com/selloffer/offer_search.htm?keywords=%BC%D2%BE%DF%D7%B0%CA%CE%B0%DA%BC%FE&spm=a26352.13672862.searchbox.0`
- Synthetic fixtures:
  - Canvas no valid outputs
  - Missing canonical Miaoshou detail ID
  - External write result unknown

- [ ] **Step 1: Add E2E UI smoke for approved navigation**

In `e2e/browser-workbench.spec.ts`, add:

```ts
test("approved navigation and product workbench surfaces are visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("商品");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("处理规则");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("写入记录");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("设置");
  await expect(page.getByRole("navigation", { name: "主导航" })).not.toContainText("任务中心");
  await expect(page.getByRole("tab", { name: /待处理|自动处理中|待确认|需要人工处理|已完成/ })).toBeVisible();
});
```

If `StageOverview` uses buttons instead of tabs, use:

```ts
await expect(page.getByRole("button", { name: /待处理/ })).toBeVisible();
```

- [ ] **Step 2: Add fixed sample spec**

Create `e2e/workbench-fixed-samples.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const samples = {
  singleA: "https://detail.1688.com/offer/1013001591920.html?spm=a26352.13672862.offerlist.74.64241e62GBUfEO&cosite=-&tracelog=p4p&_p_isad=1&clickid=d609322de4c446eb9c7ad5f32c7264ef&sessionid=79d7417242becda81904b0b6debcf258",
  singleB: "https://detail.1688.com/offer/892408514788.html",
  batch: "https://s.1688.com/selloffer/offer_search.htm?keywords=%BC%D2%BE%DF%D7%B0%CA%CE%B0%DA%BC%FE&spm=a26352.13672862.searchbox.0"
};

test("documents fixed Gate 5 samples for local live acceptance", async () => {
  expect(samples.singleA).toContain("1013001591920");
  expect(samples.singleB).toContain("892408514788");
  expect(samples.batch).toContain("s.1688.com");
});
```

This file is a guardrail so future agents do not lose the approved sample URLs. The actual live collection still requires a local browser extension session and should be recorded in the verification report.

- [ ] **Step 3: Run full local verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- lint exits 0;
- typecheck exits 0;
- unit tests pass;
- Next build succeeds.

- [ ] **Step 4: Run browser verification**

Run:

```bash
pnpm test:e2e -- e2e/browser-workbench.spec.ts e2e/workbench-fixed-samples.spec.ts
```

Expected: e2e passes in mock/local mode.

- [ ] **Step 5: Write verification report**

Create `docs/superpowers/reports/2026-07-22-workbench-experience-repair-verification.md`:

```md
# Workbench Experience Repair Verification

Date: 2026-07-22

## Automated Checks

- `pnpm lint`: record exit code and key result
- `pnpm typecheck`: record exit code and key result
- `pnpm test`: record file/test counts
- `pnpm build`: record build result
- `pnpm test:e2e -- e2e/browser-workbench.spec.ts e2e/workbench-fixed-samples.spec.ts`: record result

## Fixed Samples

- Single A: https://detail.1688.com/offer/1013001591920.html?spm=a26352.13672862.offerlist.74.64241e62GBUfEO&cosite=-&tracelog=p4p&_p_isad=1&clickid=d609322de4c446eb9c7ad5f32c7264ef&sessionid=79d7417242becda81904b0b6debcf258
- Single B: https://detail.1688.com/offer/892408514788.html
- Batch: https://s.1688.com/selloffer/offer_search.htm?keywords=%BC%D2%BE%DF%D7%B0%CA%CE%B0%DA%BC%FE&spm=a26352.13672862.searchbox.0

## Manual Live Acceptance

- 1688 selected product reaches product workbench.
- User clicks Start Processing.
- Canvas 8123 TK工作流 returns 5 usable images.
- Product detail / image confirmation page shows generated images and cleaned title.
- User clicks Confirm Write Back To Miaoshou.
- The same canonical Miaoshou public collect-box item is edited.

## Known Non-Goals

- No TikTok publish.
- No TikTok claim.
- No SaaS login.
- No Canvas reference image/style configuration.
```

- [ ] **Step 6: Update progress ledger**

In `.sdd/progress.md`, after implementation and verification:

```md
| Gate 6: write implementation plan | complete | Plan saved at `docs/superpowers/plans/2026-07-22-workbench-experience-repair.md`; implementation verification report saved after execution | Ready for implementation dispatch |
```

During plan-writing only, use:

```md
| Gate 6: write implementation plan | in_progress | Plan drafted at `docs/superpowers/plans/2026-07-22-workbench-experience-repair.md` | Review and approve execution mode |
```

---

## Review Gates During Execution

Use these checkpoints if implementing with subagents:

1. **After Task 2:** Contract/read model review. Confirm no DB migration needed and `/api/v1/products` still returns valid JSON.
2. **After Task 4:** Product workbench UI review. Confirm table fields, tabs and buttons match Gate 4 exactly.
3. **After Task 6:** Navigation/settings review. Confirm task center is gone from primary nav and diagnostics link exists.
4. **After Task 8:** External-write safety review. Confirm batch confirm still requires a user click and never exposes TikTok publish.
5. **After Task 9:** Full verification. Record exact command results and live sample status in report.

## Self-Review Checklist

- Spec coverage: Gate 4 navigation, table fields, tabs, batch actions, detail layout, settings boundary, exception recovery and Gate 5 samples are each mapped to tasks above.
- Scope control: no TikTok publish, no SaaS login, no class/category attribute default library, no Canvas reference image/style configuration.
- Contract safety: new `ProductPoolItemV1` fields are read-model only; no migration is required because data comes from existing `products` and `product_revisions`.
- External write safety: per-product and batch confirmation both use existing approval snapshot semantics before enqueueing Miaoshou edit.
- Verification: every task has focused Vitest/typecheck commands; final task has lint/typecheck/test/build/e2e/report.
