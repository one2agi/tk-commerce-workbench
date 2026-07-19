# Start Processing Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复“采集成功但看不到/点不了开始处理”的产品断点，让妙手采集成功的商品能从商品工作台进入自动化生成上架草稿、Canvas 生图、审核和妙手回写。

**Architecture:** 不重写妙手采集链路。新增一个“原始采集图片数”读模型字段，把“是否可开始处理”的依据从本地 assets 改为妙手 source_payload 里的 mainImages/detailImages；本地 assets 仍只表示自动化启动后的素材归档结果。UI 只在商品工作台执行启动，商品列表/详情给出清晰跳转和状态解释。

**Tech Stack:** TypeScript, Next.js App Router, React client components, Vitest, PostgreSQL JSONB projection, existing `StartAutomationV1` command.

## Global Constraints

- 用中文面向产品经理解释用户可见变化、业务影响、风险和下一步。
- 不暴露 `.env`、妙手密钥、LLM key、Canvas 配置、扩展令牌。
- 不改变“1688 链接 -> 妙手公共采集箱 -> 本地读取详情”的采集主链路。
- 不增加 TikTok 直接发布按钮；当前仍然是审核后同步回妙手编辑/待发布侧。
- 本地单用户，不引入账号登录。
- 先用测试证明死锁，再做最小修复。

---

## File Structure

- Modify: `packages/contracts/src/read-models.ts`
  - 给 `ProductPoolItemV1` 增加 `sourceImageCount: number`。
  - 保留 `imageCount`，含义仍为本地已归档 assets 数量。

- Modify: `apps/web/src/server/services/product-service.ts`
  - 在 `PRODUCT_POOL_SQL` 中从 `product_revisions.source_payload` 计算 `source_image_count`。
  - `toPoolItem()` 映射 `sourceImageCount`。

- Modify: `apps/web/src/components/products/product-workbench.selectors.ts`
  - `canStartAutomation()` 改用 `sourceImageCount > 0`。
  - 进度文案把 `Listing` 改为 `上架草稿`。

- Modify: `apps/web/src/components/products/product-workbench.state.test.ts`
  - 补充“source 有图但 assets 为 0 仍可开始”的 RED 测试。

- Modify: `apps/web/src/components/products/product-workbench.projection.test.ts`
  - 更新 fixtures，覆盖 `sourceImageCount` 和 `imageCount` 语义区别。

- Modify: `apps/web/src/components/products/product-table.tsx`
  - 行内增加明确的“开始处理/处理中/已开始/需补充信息”操作反馈。

- Modify: `apps/web/src/components/products/product-workbench.tsx`
  - 将 `handleStart` 传给 `ProductTable`，保证行内按钮复用同一条 `StartAutomationV1` 命令链路。

- Modify: `apps/web/src/app/products/page.tsx`
  - 商品列表页说明改为“启动处理请进入商品工作台”，避免用户误以为这里能直接执行。

- Modify: `apps/web/src/app/products/[productId]/page.tsx`
  - 商品详情页补充“去商品工作台开始处理”的入口文案。

- Test files likely touched:
  - `apps/web/src/app/products/page.test.tsx`
  - `apps/web/src/app/products/[productId]/page.test.tsx`
  - `apps/web/src/components/products/product-workbench.state.test.ts`
  - `apps/web/src/components/products/product-workbench.projection.test.ts`
  - Add if missing: `apps/web/src/components/products/product-table.test.tsx`

---

## Task 1: Add Source Image Count To Product Pool Read Model

**Files:**
- Modify: `packages/contracts/src/read-models.ts`
- Modify: `apps/web/src/server/services/product-service.ts`
- Test: existing tests that instantiate `ProductPoolItemV1`

**Interfaces:**
- Consumes: `product_revisions.source_payload.mainImages`, `product_revisions.source_payload.detailImages`
- Produces: `ProductPoolItemV1.sourceImageCount: number`

- [ ] **Step 1: Write the failing type/test expectation**

Update representative product-pool fixtures to include `sourceImageCount`. Example fixture shape:

```ts
const startableCollectedProduct: ProductPoolItemV1 = {
  productId: productId("892408514788"),
  currentRevisionId: productRevisionId("revision-892408514788"),
  sourceItemId: sourceItemId("s-1"),
  canonicalSourceTitle: "采集成功商品",
  targetTitle: null,
  canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
  locale: "th-TH",
  currency: "CNY",
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
  warningCodes: []
};
```

- [ ] **Step 2: Run typecheck to verify failure before implementation**

Run:

```bash
pnpm --filter @tk/contracts typecheck
pnpm --filter @tk/web typecheck
```

Expected before implementation: references to `sourceImageCount` fail because the contract does not expose it yet.

- [ ] **Step 3: Add the contract field**

In `packages/contracts/src/read-models.ts`, change `ProductPoolItemV1`:

```ts
  /** Product images available in the original Miaoshou collect-box payload before local archiving. */
  sourceImageCount: number;
  /** Total archived source/product images available after automation starts. */
  imageCount: number;
```

- [ ] **Step 4: Project source_image_count from source_payload**

In `apps/web/src/server/services/product-service.ts`, add this select expression near `image_count`:

```sql
       (
         jsonb_array_length(
           CASE
             WHEN jsonb_typeof(revision.source_payload->'mainImages') = 'array'
             THEN revision.source_payload->'mainImages'
             ELSE '[]'::jsonb
           END
         )
         +
         jsonb_array_length(
           CASE
             WHEN jsonb_typeof(revision.source_payload->'detailImages') = 'array'
             THEN revision.source_payload->'detailImages'
             ELSE '[]'::jsonb
           END
         )
       )::integer AS source_image_count,
```

Then map it in `toPoolItem()`:

```ts
    sourceImageCount: Number(row.source_image_count ?? 0),
    imageCount: Number(row.image_count ?? 0),
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --filter @tk/contracts typecheck
pnpm --filter @tk/web typecheck
```

Expected: both pass.

---

## Task 2: Fix Start Eligibility And Product-Facing Copy

**Files:**
- Modify: `apps/web/src/components/products/product-workbench.selectors.ts`
- Modify: `apps/web/src/components/products/product-workbench.state.test.ts`
- Modify: `apps/web/src/components/products/product-workbench.projection.test.ts`

**Interfaces:**
- Consumes: `ProductPoolItemV1.sourceImageCount`
- Produces: fixed `canStartAutomation(item): boolean`

- [ ] **Step 1: Add RED test for the deadlock**

In `apps/web/src/components/products/product-workbench.state.test.ts`, add:

```ts
it("allows a collected product to start when source payload has images but local assets are not archived yet", () => {
  const collectedButNotArchived = {
    ...items[0]!,
    sourceImageCount: 8,
    imageCount: 0,
    automation: "not_started" as const,
    assetArchive: "pending" as const,
    listing: "pending" as const,
    canvas: "not_started" as const
  };

  let s = createWorkbenchState([collectedButNotArchived]);
  s = toggleSelection(s, String(collectedButNotArchived.productId));

  expect(s.selectedIds.has(String(collectedButNotArchived.productId))).toBe(true);
  expect(s.batchButtonEnabled).toBe(true);
  s = openDrawer(s, String(collectedButNotArchived.productId));
  expect(s.drawerStartButtonEnabled).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm --filter @tk/web test -- product-workbench.state.test.ts
```

Expected before implementation: FAIL because `canStartAutomation()` still requires `imageCount > 0`.

- [ ] **Step 3: Update selector**

In `apps/web/src/components/products/product-workbench.selectors.ts`, change:

```ts
    item.imageCount > 0
```

to:

```ts
    item.sourceImageCount > 0
```

Also change the progress label:

```ts
    { key: "listing", label: "上架草稿", state: listing },
```

- [ ] **Step 4: Update blocked test case**

In `product-workbench.state.test.ts`, replace the current missing image case:

```ts
["missing source images", { imageCount: 0 }]
```

with:

```ts
["missing source images", { sourceImageCount: 0 }]
```

Ensure default test items contain:

```ts
sourceImageCount: 1,
imageCount: 0,
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- product-workbench.state.test.ts product-workbench.projection.test.ts
```

Expected: tests pass.

---

## Task 3: Make Start Processing Visible In The Workbench Row

**Files:**
- Modify: `apps/web/src/components/products/product-table.tsx`
- Modify: `apps/web/src/components/products/product-workbench.tsx`
- Test: add or update `apps/web/src/components/products/product-table.test.tsx`

**Interfaces:**
- Consumes: `canStartAutomation(item)`, `startStatusById`, `onStart(productId)`
- Produces: row-level action button that calls the same `StartAutomationV1` path as drawer/batch start

- [ ] **Step 1: Extend ProductTable props**

In `ProductTable` props add:

```ts
  onStart: (productId: string) => void;
```

Pass it from `ProductWorkbench`:

```tsx
          onStart={handleStart}
```

- [ ] **Step 2: Add row action rendering**

Inside the 操作 column, keep “查看详情” and add a start button. Use this logic:

```tsx
const canStart = canStartAutomation(item);
const startDisabled = startStatus === "pending" || startStatus === "success" || !canStart;
const startText = startStatus === "pending"
  ? "处理中"
  : startStatus === "success"
    ? "已开始"
    : startStatus === "failure"
      ? "重试处理"
      : "开始处理";
const blockedReason = !canStart && item.automation === "not_started"
  ? item.sourceImageCount <= 0
    ? "妙手原始数据没有可用图片"
    : item.canonicalSuccessDetailId === null
      ? "缺少妙手采集箱详情 ID"
      : "采集尚未成功"
  : null;
```

Render:

```tsx
<div className="tk-product-table__actions">
  <button
    type="button"
    aria-label={`查看详情 ${item.productId}`}
    onClick={() => onOpenDrawer(String(item.productId))}
  >
    查看详情
  </button>
  <button
    type="button"
    aria-label={`${startText} ${item.productId}`}
    disabled={startDisabled}
    title={blockedReason ?? undefined}
    onClick={() => onStart(String(item.productId))}
  >
    {startText}
  </button>
  {blockedReason ? <span className="tk-start-status">{blockedReason}</span> : null}
</div>
```

- [ ] **Step 3: Add component test**

Create `apps/web/src/components/products/product-table.test.tsx` if missing:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { miaoshouDetailId, productId, productRevisionId, sourceItemId } from "@tk/contracts/ids";
import { ProductTable } from "./product-table";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

function item(overrides: Partial<ProductPoolItemV1> = {}): ProductPoolItemV1 {
  return {
    productId: productId("892408514788"),
    currentRevisionId: productRevisionId("revision-892408514788"),
    sourceItemId: sourceItemId("s-1"),
    canonicalSourceTitle: "测试商品",
    targetTitle: null,
    canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    sourceImageCount: 6,
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

describe("ProductTable start action", () => {
  it("shows a row-level start button for a collected product before local assets are archived", async () => {
    const onStart = vi.fn();
    render(
      <ProductTable
        items={[item()]}
        filtered={[item()]}
        selectedIds={new Set()}
        startStatusById={new Map()}
        activeStage="all"
        onToggleSelection={vi.fn()}
        onOpenDrawer={vi.fn()}
        onScroll={vi.fn()}
        scrollTop={0}
        onStart={onStart}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /开始处理 892408514788/ }));
    expect(onStart).toHaveBeenCalledWith("892408514788");
  });
});
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- product-table.test.tsx product-workbench.state.test.ts
```

Expected: tests pass.

---

## Task 4: Make Non-Workbench Pages Product-Clear

**Files:**
- Modify: `apps/web/src/app/products/page.tsx`
- Modify: `apps/web/src/app/products/page.test.tsx`
- Modify: `apps/web/src/app/products/[productId]/page.tsx`
- Modify: `apps/web/src/app/products/[productId]/page.test.tsx`

**Interfaces:**
- Consumes: existing route `/`
- Produces: clear CTA/copy so users know where to start processing

- [ ] **Step 1: Update product list copy**

In `apps/web/src/app/products/page.tsx`, change the explanatory paragraph to:

```tsx
<p>
  这里用于查看当前工作区已收录的全部商品。采集成功后，请回到
  <a href="/">商品工作台</a>
  勾选商品并点击“开始处理”，系统会生成上架草稿、归档图片、调用 Canvas 生图，并在审核后同步回妙手。
</p>
```

- [ ] **Step 2: Update product detail page copy**

In `apps/web/src/app/products/[productId]/page.tsx`, after `<h1>` add:

```tsx
<p>
  当前详情页用于查看商品结果；如需启动标题清洗、定价和 Canvas 生图，请回到
  <a href="/">商品工作台</a>
  点击“开始处理”。
</p>
```

- [ ] **Step 3: Update tests**

In `products/page.test.tsx`, assert:

```ts
expect(screen.getByRole("link", { name: "商品工作台" })).toHaveAttribute("href", "/");
expect(screen.getByText(/开始处理/)).toBeInTheDocument();
```

In `products/[productId]/page.test.tsx`, assert:

```ts
expect(screen.getByRole("link", { name: "商品工作台" })).toHaveAttribute("href", "/");
expect(screen.getByText(/Canvas 生图/)).toBeInTheDocument();
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm --filter @tk/web test -- products/page.test.tsx products/[productId]/page.test.tsx
```

Expected: tests pass.

---

## Task 5: Runtime E2E Acceptance

**Files:**
- No source files unless verification reveals a defect.

**Interfaces:**
- Consumes: live local runtime on port 3000 and worker process
- Produces: evidence that one real collected product can move from `not_started` to queued/running automation

- [ ] **Step 1: Run static checks**

Run:

```bash
pnpm --filter @tk/contracts typecheck
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web lint
pnpm --filter @tk/web build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm --filter @tk/web test -- product-workbench.state.test.ts product-workbench.projection.test.ts product-table.test.tsx products/page.test.tsx products/[productId]/page.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 3: Verify live API projection**

Run against local runtime:

```bash
curl --noproxy '*' -s http://127.0.0.1:3000/api/v1/products \
  | jq '.items[] | {productId, miaoshouSource, automation, sourceImageCount, imageCount, canonicalSuccessDetailId}'
```

Expected for the newly collected product:

```json
{
  "miaoshouSource": "success",
  "automation": "not_started",
  "sourceImageCount": 1,
  "imageCount": 0,
  "canonicalSuccessDetailId": "..."
}
```

`sourceImageCount` can be any positive number. `imageCount` may remain 0 before processing.

- [ ] **Step 4: Verify UI shows the button**

Open `http://127.0.0.1:3000/`.

Expected:

- The collected product row shows “开始处理”.
- The row checkbox is selectable.
- The footer shows “批量开始处理（1）” after selecting that row.
- Drawer also shows “开始处理”.

- [ ] **Step 5: Start one product and verify job creation**

Click row “开始处理” or batch button. Then run:

```bash
curl --noproxy '*' -s http://127.0.0.1:3000/api/v1/tasks \
  | jq '.items[] | select(.kind=="asset_archive" or .kind=="listing_generate" or .kind=="canvas_generate") | {jobId, kind, status, revisionId}'
```

Expected: at least one automation job appears for the selected revision, usually `asset_archive` first.

---

## Rollback Plan

If the change causes UI or projection instability:

1. Revert only the `sourceImageCount` contract/projection/selector changes.
2. Keep no database migration; this plan only changes a read projection.
3. Restore `canStartAutomation()` to use `imageCount > 0`.
4. Re-run:

```bash
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web test -- product-workbench.state.test.ts
```

---

## Product Acceptance Criteria

- 采集成功但本地 assets 为 0 的商品，可以被勾选。
- 商品工作台行内可以直接点击“开始处理”。
- 抽屉里仍有“开始处理/重试处理”。
- 商品列表和商品详情不再让用户误判“这里坏了”，而是明确提示去商品工作台处理。
- “Listing” 用户可见文案改为“上架草稿”。
- 点击开始后能创建自动化任务，不再停留在“未处理且无入口”的状态。

---

## Self-Review

- Spec coverage: 覆盖了用户当前抱怨的两个核心问题：没有开始处理入口、采集后未处理无法推进。
- No placeholders: 本计划没有 TBD/TODO/implement later。
- Type consistency: `sourceImageCount` 在 contract、service projection、selector、fixtures 中统一命名；`imageCount` 保持本地 assets 含义。
