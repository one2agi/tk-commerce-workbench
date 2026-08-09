# 商品详情图片工作台前端体验收口实施计划

> **执行要求：** 实施时使用 `superpowers:test-driven-development`，按任务逐项完成并独立提交；全部任务完成后使用 `superpowers:verification-before-completion`。本计划只做前端体验收口及必要的 Web 读模型/命令边界调整，不重构生图 Worker、模型供应商或图片存储流程。

## 目标

把 `/products/[productId]` 从“技术状态拼装页”收口成一个稳定、简单、可恢复的商品图片工作台：

1. 始终直接展示该商品的全部采集原图。
2. 始终将原产品图与洗图后的图分区展示。
3. 用户按业务顺序完成“选择原图 → 设置品类/数量 → 开始洗图 → 处理失败 → 选择最终图 → 确认 → 写回妙手”。
4. 所有按钮都有真实行为，所有请求都有进行中、成功或失败反馈。
5. 页面刷新后继续显示真实任务状态，不依赖浏览器内存判断进度。

## 核心产品原则

> 把复杂的采集、生图、重试、存储和写回流程留在系统内部；把清楚的选择、明确的状态和安全的操作交给用户。

本轮每项设计必须同时满足：

- **业务顺序优先：** 页面从上到下即为操作顺序。
- **结果直接可见：** 原图、洗图结果、最终顺序不藏在二级入口。
- **状态说人话：** 不直接暴露 `queued`、`worker.handler_failed` 等技术状态。
- **失败可以恢复：** 单张重试不影响成功图片。
- **外部写入安全：** 写回前明确目标、图片数量和顺序。
- **不过度设计：** 不增加 Canvas、节点编排、拖拽排序或装饰性动画。

## 已确认的现状

- 商品详情页由 `FinalReview` 渲染，当前图片区位于三栏布局左侧，宽度不足以承载全部图片。
- `ProductImageGallery` 已具备原图/洗图分区、数量、横向浏览、弹窗预览和键盘切换能力，但目前挂在商品列表展开行。
- `ImageGenerationPanel` 已具备原图选择、输出数量、单张重试和排除按钮，但：
  - 原图仅在 `not_started` 状态显示；
  - “更改品类”无实现；
  - 请求失败不展示原因；
  - 刷新后轮询依赖丢失的本地 `mode`；
  - “重新开始”只改本地状态，没有创建新批次；
  - 接受部分成功接口尚未接到 UI。
- `ProductWorkspaceV1.originalListing.mainImages/detailImages` 已提供采集源图。
- `ImageGenerationViewV1.availableInputs` 和成功 slot 的 `localUrl` 已提供本地资产地址。
- 后端已有：开始洗图、单张重试、排除未执行槽位、按顺序接受成功槽位、模板列表等接口。
- 新无头生图是默认路径，但部分前端仍显示 Canvas 文案。

## 非目标

- 不修改提示词规划、生图 API、Worker 调度、内容寻址存储和妙手发布算法。
- 不删除旧 Canvas 数据及回滚兼容能力；只把普通用户界面的默认文案改为“洗图”。
- 不做拖拽排序；使用“左移/右移”按钮。
- 不在主界面展示批次 ID、远程任务 ID、哈希、模型原始响应。
- 不调用真实付费模型完成本轮 UI 验收；使用现有 mock/E2E 数据。
- 不在本轮扩展为全站视觉重做。

## 目标页面结构

```text
商品标题 / 返回商品处理台

┌ 图片工作台（全宽）────────────────────────────┐
│ 原产品图 12 张                                 │
│ [选择✓] [选择✓] [ ] [ ] ...                  │
│ 采集完成即展示 · 点击可放大                    │
│                                               │
│ 洗图设置                                      │
│ 品类 [草帽 ▼]  已选原图 2/6  输出 [− 4 +]     │
│ [开始洗图]                                    │
│                                               │
│ 洗图后的图 4/5                                │
│ [成功] [成功] [失败·重试] [处理中]             │
│                                               │
│ 最终使用图片                                  │
│ [1 主图][← →] [2][← →] [3][← →]              │
│ [确认使用这 3 张图片]                          │
└───────────────────────────────────────────────┘

┌ 商品内容与 SKU ─────────────┐ ┌ 审核与写回 ───┐
│ 标题、属性、价格、SKU         │ │ 检查结果       │
│ 低频采集原文默认收起          │ │ 写回目标       │
│                               │ │ [写回妙手]     │
└───────────────────────────────┘ └───────────────┘
```

桌面端图片工作台全宽；内容区与审核区为两栏。窄屏按同一业务顺序变为单栏，不改变操作含义。

## 前端组件边界

- 新增 `ProductImageWorkbench` 作为详情页唯一图片交互容器，统一持有：原图选择、品类、输出数量、最终图片选择与顺序、请求反馈。
- `ProductImageGallery` 继续负责图片条带和弹窗，但改为受控展示组件；原图 tile 可选时直接显示选择标记，不再额外渲染第二套“选择原图”网格。
- `ImageGenerationPanel` 收窄为洗图设置、批次状态和单槽操作；选择结果由 `ProductImageWorkbench` 传入，避免两份 React 状态相互漂移。
- `FinalImageOrder` 收窄为受控最终顺序展示和左右移动按钮；确认请求仍由工作台统一发出。
- `FinalReview` 只负责页面信息架构和把 workspace 数据传给工作台，不自行拼接图片状态。
- 图片本体按钮只负责打开预览；旁边独立复选框负责“选作洗图输入”或“选作最终图片”，避免一次点击同时触发预览和选择。

图片标准化为受控 view model：

```ts
type WorkbenchImage = Readonly<{
  key: string;
  url: string;
  assetId: string | null;
  slotId: string | null;
  source: "collected" | "headless" | "legacy_canvas";
  status: "ready" | "planning" | "generating" | "failed";
  selectable: boolean;
}>;
```

源 payload 中存在、但尚未归档成本地 ready asset 的图片仍要展示，不过不能用于洗图，并显示“尚未保存完成”；不得静默丢弃。

## 优先级

- **P0 / 上线前必须完成：** Task 1–6。确保详情页位置正确、全部原图可见、设置可用、进度可恢复、错误有反馈。
- **P1 / 形成业务闭环：** Task 7–8。确保最终图片顺序持久化并安全写回妙手。
- **P2 / 管理能力完善：** Task 9。模板编辑不阻断单商品主流程，但应在正式扩大类目使用前完成。
- **发布门禁：** Task 10。任何 P0/P1 实现都必须经过 mock 浏览器流程，不以组件截图代替业务验收。

## 用户状态与操作规则

| 页面状态 | 用户看到的主状态 | 可执行操作 |
|---|---|---|
| 无批次 | 等待开始 | 选择 1–6 张原图、选择品类、设置 1–8 张输出、开始洗图 |
| 规划中 | 正在分析商品图片 | 查看原图；不可重复提交 |
| 生成中 | 正在生成 2/5 | 查看各图片状态；未执行槽位可取消 |
| 部分成功 | 已完成 4/5 | 使用成功结果、单独重试失败图片 |
| 全部成功 | 已完成 5/5 | 选择最终图片、调整顺序、确认使用 |
| 失败 | 本批没有可用结果 | 单张重试；调整参数新建一批 |
| 已确认 | 已确认 4 张最终图片 | 查看最终顺序；进入审核与妙手写回 |
| 写回中 | 正在写回妙手 | 禁止重复提交；允许查看图片 |
| 写回失败 | 写回失败，图片未丢失 | 查看安全原因；符合条件时重新写回 |

## 错误文案规则

每个错误包含“发生了什么 + 对已有结果的影响 + 下一步”：

- `template_not_found` → “该品类还没有启用洗图模板，请先到模板管理中启用。”
- `asset_not_ready` → “所选原图尚未保存完成，请刷新后重新选择。”
- `slot_not_retryable` → “这张图片当前不能重试，页面将刷新最新状态。”
- 网络中断 → “请求未完成，已经生成的图片不会丢失，请重试。”
- 下载超时 → “这张图片下载超时，其他成功图片不受影响。”
- 未知错误 → “操作失败，任务状态已保留；请刷新后重试。”

技术错误码保留在可展开的“查看技术详情”中，不作为主文案。

---

## Task 1：修正详情页图片读模型的空批次投影

**目的：** 即使从未启动过洗图，详情页也必须取得全部可选本地原图，不能因为 `batchId` 为空而返回 `imageGeneration: null`。

**文件：**

- 修改：`packages/contracts/src/read-models.ts`
- 修改：`apps/web/src/server/services/product-service.ts`
- 修改：`apps/web/src/server/services/product-service.test.ts`

**步骤：**

1. 先增加失败测试：没有生图批次但存在 ready/source assets 时，`imageGeneration` 状态为 `not_started`，`batchId` 为 `null`，并返回全部 `availableInputs`。
2. 保留原图资产顺序；不得把 generated assets 混入原图。
3. 批次存在时继续投影 selected inputs、slots、accepted order 和状态。
4. 给 slot 读模型增加持久化的 `acceptedOrder: number | null`，使刷新后仍能恢复用户确认顺序。
5. 运行产品服务测试和 contracts typecheck。

**验收：** 新采集商品第一次打开详情页即可看到并选择全部本地原图。

**提交：** `fix(web): project image workspace before first batch`

---

## Task 2：把图片分区从商品列表迁移到详情页

**目的：** 满足“图片应该在商品详情页面”的明确要求，并降低商品列表信息密度。

**文件：**

- 新增：`apps/web/src/components/products/product-image-workbench.tsx`
- 新增：`apps/web/src/components/products/product-image-workbench.test.tsx`
- 修改：`apps/web/src/components/products/product-table.tsx`
- 修改：`apps/web/src/components/products/product-table.test.tsx`
- 修改：`apps/web/src/components/products/product-image-gallery.tsx`
- 修改：`apps/web/src/components/products/product-image-gallery.test.tsx`
- 修改：`apps/web/src/components/review/final-review.tsx`
- 修改：`apps/web/src/app/products/[productId]/page.test.tsx`

**步骤：**

1. 先修改测试，要求商品列表不再渲染整行图片画廊，只保留商品缩略图、状态和“查看详情”。
2. 新增 `ProductImageWorkbench`，在详情页中挂载唯一一套原图/洗图分区。
3. 原图优先使用本地 `availableInputs.localUrl`；若本地归档暂不可用，回退到 source payload 的主图和详情图，并标记为不可选择。
4. 原图按“主图在前、详情图在后”去重，并展示真实总数，不截断为 9 张。
5. 洗图结果包含当前无头批次成功 slot；旧 Canvas 成功结果仅作为兼容来源补充并去重。
6. 将“Canvas 生成后自动补充”改为“洗图完成后自动展示”。
7. 图片本体点击只打开预览；使用独立复选框选择洗图输入，避免行为歧义。原图仍只显示一套，不在 `ImageGenerationPanel` 内复制缩略图。
8. 保留弹窗、左右键、Esc 关闭及关闭后焦点返回。

**验收：** 详情页在任务开始前、运行中、完成后都同时存在“原产品图”和“洗图后的图”；列表页不再铺开全部图片。

**提交：** `feat(web): move complete image gallery to product detail`

---

## Task 3：重组详情页为全宽图片工作台

**目的：** 让图片成为详情页第一工作对象，而不是挤在三栏布局的窄侧栏。

**文件：**

- 修改：`apps/web/src/components/review/final-review.tsx`
- 修改：`apps/web/src/app/globals.css`
- 修改：`apps/web/src/app/final-review.test.tsx`
- 修改：`apps/web/src/app/product-safety.test.tsx`

**步骤：**

1. 将图片工作台移到标题下方并占满内容宽度。
2. 下方改为“商品内容 + 审核写回”两栏；小于 900px 时按业务顺序变成单栏。
3. 低频采集原文和属性明细继续使用 `<details>` 收起。
4. 批次 ID 从默认界面移到“技术详情”，避免干扰普通操作。
5. 保持现有颜色、字体、卡片和按钮体系，不引入新的视觉语言。

**验收：** 1280px 和 1440px 桌面宽度下原图与洗图结果可清楚查看；移动宽度下没有横向页面溢出。

**提交：** `refactor(web): prioritize product image workflow`

---

## Task 4：修复洗图设置与品类选择

**目的：** 删除无效按钮，并让用户能在开始前纠正自动识别的品类。

**文件：**

- 修改：`apps/web/src/components/products/product-image-workbench.tsx`
- 修改：`apps/web/src/components/products/product-image-workbench.test.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.test.tsx`
- 复用：`GET /api/v1/image-generation-templates`

**步骤：**

1. 用现有模板列表接口加载 active 模板的类目选项。
2. 将无效“更改品类”按钮替换为简单下拉框；默认选择 confirmed category，其次 inferred category。
3. 没有可用模板时禁用开始按钮，并提供“前往模板管理”链接。
4. 工作台原图分区显示“已选 X/6”；达到上限后不再新增，并说明最多 6 张。`ImageGenerationPanel` 不再重复渲染原图。
5. 输出数量继续使用 `− / 数量 / +`，显示允许范围 1–8。
6. 开始按钮旁不增加额外高级参数。

**验收：** 页面不存在无行为按钮；用户能明确知道选择了几张输入图、将生成几张输出图以及使用哪个类目模板。

**提交：** `fix(web): make image generation setup actionable`

---

## Task 5：以服务端状态驱动进度和轮询

**目的：** 页面刷新后继续自动显示真实进度，避免任务实际运行但页面停住。

**文件：**

- 修改：`apps/web/src/components/products/product-image-workbench.tsx`
- 修改：`apps/web/src/components/products/product-image-workbench.test.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.test.tsx`

**步骤：**

1. 删除以本地 `mode` 作为轮询真相的逻辑。
2. 只要 slots 中存在 `waiting_for_plan`、`queued` 或 `running`，每 3 秒执行 `router.refresh()`。
3. 进入成功、失败、全部排除或组件卸载时停止轮询。
4. 开始请求期间使用单独 `submitting` 状态防止双击。
5. 刷新页面后根据服务端 projection 自动恢复轮询。
6. 浏览器转到后台时降低无意义刷新；回到前台立即刷新一次。

**验收：** 在生成中刷新详情页，无需重新点击任何按钮，进度仍会自动更新直至稳定状态。

**提交：** `fix(web): resume image progress after refresh`

---

## Task 6：补齐操作反馈和恢复动作

**目的：** 每次点击都有可见反馈，失败时告诉用户影响和下一步。

**文件：**

- 修改：`apps/web/src/components/products/product-image-workbench.tsx`
- 修改：`apps/web/src/components/products/product-image-workbench.test.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.test.tsx`
- 可新增：`apps/web/src/components/products/image-generation-message.ts`

**步骤：**

1. 所有 fetch 都检查 `response.ok` 并解析稳定错误码。
2. 开始、重试、排除、确认分别具有独立 pending 状态，避免一个操作锁住整页。
3. 使用一个靠近操作区的 `role="status"`/`role="alert"` 展示中文反馈。
4. 成功图片始终保留；单张失败只在该卡片显示错误和“重新生成这张”。
5. 删除当前无效“重新开始”。
6. 用“调整参数新建一批”代替；打开设置前明确提示已有成功结果不会删除。
7. 若需要相同参数再次付费生成，在 Web 命令边界增加一次性 `runIntentId`：同一次点击重放仍幂等，用户明确点击“新建一批”才产生新批次。不得以时间戳破坏双击幂等性。
8. `runIntentId` 的实现同时修改并测试：`image-generations/route.ts`、`image-generation-service.ts`、各自测试；只影响 Web 命令幂等键，不改变 Worker 生图流程。

**验收：** 断网、接口 409、接口 500 和单图失败都能看到清楚提示；不存在点击无反应的按钮。

**提交：** `fix(web): make image actions recoverable`

---

## Task 7：接通最终图片选择、顺序和确认

**目的：** 让现有 accept-partial 接口成为用户可见的正式步骤。

**文件：**

- 修改：`apps/web/src/components/products/product-image-workbench.tsx`
- 修改：`apps/web/src/components/products/product-image-workbench.test.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.tsx`
- 修改：`apps/web/src/components/products/image-generation-panel.test.tsx`
- 修改：`apps/web/src/components/review/final-image-order.tsx`
- 修改：`apps/web/src/components/review/final-image-order.test.tsx`
- 复用：`POST /api/v1/products/[productId]/image-generations/[batchId]/accept`

**步骤：**

1. 成功 slot 提供“使用此图”复选状态；失败或处理中 slot 不能进入最终顺序。
2. 默认选中当前已接受的图片；尚未接受时默认选中所有成功图片，但不自动提交。
3. 使用“左移/右移”按钮排序，第一张明确标记为“主图”；不使用拖拽。
4. “确认使用这 X 张图片”提交 ordered slot IDs。
5. 成功后刷新 projection，展示持久化后的最终顺序和“已确认”。
6. 如果没有成功图片或没有勾选图片，禁用确认并显示原因。
7. `FinalImageOrder` 删除 Canvas 专属文案，统一为“洗图结果”和“待确认图片”。

**验收：** 用户选择 3 张成功图片并调整顺序后刷新页面，顺序保持不变；妙手审核使用同一顺序。

**提交：** `feat(web): confirm ordered generated images`

---

## Task 8：收口审核与妙手写回区

**目的：** 写回前让用户明确知道写回目标、图片数量和前置条件。

**文件：**

- 修改：`apps/web/src/components/review/approval-actions.tsx`
- 修改：`apps/web/src/components/review/approval-actions.safety.test.tsx`
- 修改：`apps/web/src/components/review/final-review.tsx`

**步骤：**

1. 在主按钮前显示：妙手目标 ID、最终图片数量、第一张主图缩略图、当前审批状态。
2. 没有确认最终图片、listing 未完成或写回正在执行时禁用写回按钮，并展示具体原因。
3. 主按钮文案统一为“确认并写回妙手”；重试文案统一为“重新写回妙手”。
4. 确认成功后显示“已进入妙手同步队列”；不把排队误写为已完成。
5. 写回失败时明确说明图片和审批结果仍保留，不触发重新生图。
6. 将“从 Canvas 节点重跑”等技术操作移入高级恢复区域，并根据当前 `IMAGE_GENERATION_PATH` 使用“从洗图环节重跑”的用户文案。

**验收：** 用户在写回前能够确认目标和图片顺序；重复点击不会产生第二次写回任务。

**提交：** `fix(web): clarify final approval and miaoshou writeback`

---

## Task 9：完善模板管理的可编辑能力

**目的：** 让模板管理真正可管理，但保持普通商品操作页面简单。

**文件：**

- 修改：`apps/web/src/components/templates/image-generation-template-manager.tsx`
- 修改：`apps/web/src/components/templates/image-generation-template-manager.test.tsx`
- 必要时新增：模板更新 route/service tests

**步骤：**

1. 默认只展示名称、类目、版本、输入/输出范围和状态。
2. 高级设置展开后允许编辑必须保留、视觉方向、禁止内容和各图片角色说明。
3. 修改已启用版本时创建新草稿版本，不原地篡改历史版本。
4. 测试提示词使用明确选择的样例商品，不再硬编码不可解释的 `probe`。
5. 保存、测试、启用操作分别提供 pending、成功和失败反馈。

**验收：** 用户无需修改代码即可新增并调整类目模板；历史生图批次继续引用旧版本快照。

**提交：** `feat(web): make category image templates editable`

---

## Task 10：浏览器验收与回归门禁

**目的：** 证明 UI 不只是组件测试通过，而是完整业务故事可用。

**文件：**

- 修改：`e2e/headless-image-generation.spec.ts`
- 修改：`e2e/full-mocked-flow.spec.ts`
- 可新增：`e2e/product-image-workbench.spec.ts`

**必须覆盖：**

1. 新采集商品详情页直接显示全部原图。
2. 原图和洗图图始终分区，不需要点击列表下方展开。
3. 选择 2 张原图、输出 4 张并开始洗图。
4. 刷新页面后进度继续自动更新。
5. 3 张成功、1 张失败时只重试失败图片。
6. 选择最终 3 张，通过按钮调整顺序并确认。
7. 刷新页面后确认顺序保持。
8. 写回前显示目标和 3 张图片，写回排队状态准确。
9. 旧 Canvas 成功结果仍能显示和审核，但普通文案不暴露 Canvas。
10. 1280×800、1440×900 和 390×844 三个视口无主要内容遮挡或页面级横向滚动。

**验证命令：**

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
TEST_DATABASE_URL=pglite://_test pnpm test:integration
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench_test \
  pnpm exec playwright test e2e/product-image-workbench.spec.ts e2e/headless-image-generation.spec.ts --reporter=line
```

**人工验收清单：**

- 首屏能否一眼看出下一步。
- 所有主按钮是否只有一个明确用途。
- 任何点击是否在 200ms 内出现视觉反馈。
- 失败是否说明已有成功结果不受影响。
- 页面刷新是否丢失选择、确认或任务状态。
- 原图与洗图图是否在任何任务状态下都可见。
- 写回前是否能确认目标、数量和主图。

**提交：** `test: verify product image workbench experience`

---

## 实施顺序与检查点

```text
Checkpoint A：Task 1–3
详情页始终有完整原图/洗图分区，布局正确。

Checkpoint B：Task 4–6
设置、进度、轮询和错误恢复没有无效操作。

Checkpoint C：Task 7–8
最终图片顺序、确认和妙手写回形成闭环。

Checkpoint D：Task 9–10
模板可管理，浏览器完整验收通过。
```

每个 checkpoint 完成后运行 Web focused tests；Task 10 再运行全量门禁。任何阶段不得把其他 harness 的 `docs/superpowers/agents/**` 文件加入提交。

## 主要风险与控制

1. **全部原图数量过多导致详情页变长**

   使用横向滚动条带和数量标签，仍渲染全部图片；不截断、不藏到“点击下方”。

2. **新建一批导致重复付费**

   新批次必须来自明确用户动作，并使用 `runIntentId` 保证同一次提交幂等；普通刷新和双击不得创建新付费任务。

3. **旧 Canvas 兼容被 UI 重构破坏**

   数据读取继续支持 legacy outputs，E2E 保留旧任务审核用例；仅替换普通用户文案。

4. **最终顺序只存在浏览器内存**

   接受接口成功后以数据库 accepted order/working draft 为真相，刷新验证顺序。

5. **列表和详情重复展示造成信息噪音**

   全量图片只在详情页；列表只保留识别商品所需的一个缩略图和状态摘要。

## 完成定义

只有同时满足以下条件，本轮才能宣布完成：

- 商品详情页在所有状态下直接展示全部采集原图。
- 原产品图与洗图后的图始终分区。
- 页面刷新后生图进度自动恢复。
- 所有可见按钮都有真实行为和错误反馈。
- 用户可以不用拖拽完成最终图片选择与排序。
- 最终顺序持久化，并被妙手审核/写回使用。
- 旧 Canvas 历史结果不被破坏。
- lint、typecheck、build、unit、integration、mock E2E 全部通过。
- 未执行真实付费模型调用，除非用户另行明确批准。
