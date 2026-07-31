# 商品详情洗图展示与妙手写回恢复实施计划

> 实施约束：按测试驱动逐项完成；每一步先看到目标测试失败，再写最小实现。工作区已有未提交文件不得混入本任务提交。

**目标：** 让商品详情页快速、去重地展示本地洗图，并把妙手写回未生效状态和安全人工重试闭环呈现给用户。

**架构：** Web 读模型统一提供本地资产缩略图和写回状态；资产内容路由按参数生成缩略图。Worker 在首次不确定失败和远端核对之间保留两层证据。数据库仓储以事务验证 `no_change`、当前版本和任务状态后创建一个无旧远端标记的新写回任务。

**技术栈：** TypeScript 5.9、Next.js 16 App Router、React 19、PostgreSQL JSONB、Sharp 0.34、Vitest、Testing Library、Playwright。

## 全局约束

- 不自动重试妙手写入。
- 只有结构化 `reconciliation.state = no_change`，或兼容错误码明确等于 `miaoshou_reconcile_no_change` 时才可能重试。
- 服务端必须再次校验资格，不能信任前端的 `retryAllowed`。
- 重试复用不可变审批快照，但必须创建没有 `remote_task_id` 的新任务。
- 不记录妙手响应正文、Cookie、签名或完整请求体。
- 图片写回仍使用批准的原始本地资产；缩略图只供浏览。
- 不修改当前已变更的 `globals.css`、产品列表组件和启动脚本。

## Task 1：本地资产缩略图

**修改：**

- `apps/web/src/app/api/v1/assets/[assetId]/content/route.test.ts`
- `apps/web/src/app/api/v1/assets/[assetId]/content/route.ts`
- `apps/web/package.json`
- `pnpm-lock.yaml`

1. 为资产内容路由补充失败测试：默认请求原样返回；`variant=thumbnail` 调用注入的图片转换器并返回 WebP；非法 variant 返回 400；转换失败不缓存。
2. 运行路由定向测试，确认新增场景失败。
3. 扩展路由依赖，允许注入 `thumbnailer`；生产环境用 Sharp 将最长边限制为 480 像素，自动旋转并输出 WebP。
4. 默认路径继续读取原文件，保持已有安全边界和响应类型。
5. 给 Web 包显式声明 `sharp@0.34.5`，更新锁文件 importer。
6. 运行定向测试和 Web 类型检查。

## Task 2：详情页图片本地化与去重

**修改：**

- `apps/web/src/components/review/review-workspace-view.ts`
- `apps/web/src/server/services/product-service.test.ts`
- `apps/web/src/server/services/product-service.ts`
- `apps/web/src/components/review/final-image-order.test.tsx`
- `apps/web/src/components/review/final-image-order.tsx`

1. 先写服务测试：最终图片只要有 `local_path` 就优先返回本地内容地址，并额外返回缩略图地址；不得优先使用 Canvas 远程 URL。
2. 先写组件测试：已经进入最终顺序的 Canvas 资产不在 Canvas 区重复渲染；未入选输出仍显示。
3. 运行两个测试文件并确认失败。
4. 把 `orderedFinalImages` 扩展为 `{ assetId, previewUrl, thumbnailUrl }`，服务端统一生成同源地址。
5. `FinalImageOrder` 缩略列表使用 `thumbnailUrl`，输出区按资产 ID 去重；大图地址保留 `previewUrl`。
6. 运行定向测试和 Web 类型检查。

## Task 3：保留首次失败与核对证据

**修改：**

- `packages/adapters/src/miaoshou/edit-adapter.test.ts`
- `packages/adapters/src/miaoshou/edit-adapter.ts`
- `apps/worker/src/handlers/miaoshou-edit.test.ts`
- `apps/worker/src/handlers/miaoshou-edit.ts`
- `packages/db/src/integration/repositories.integration.test.ts`
- `packages/db/src/repositories/approval-repository.ts`

1. 写适配器失败测试：HTTP 层抛出的安全 `ExternalFailure.code` 被保留；远端 5xx/超时码被规范化后保留，不能统一变成 `miaoshou.edit_result_unknown`。
2. 写 Worker 失败测试：首次失败先保存；核对 `no_change` 调用新的“合并核对结果”仓储方法。
3. 写仓储集成测试：错误 JSON 同时保留 `initialFailure` 与 `reconciliation`，核对结果不覆盖首次证据。
4. 运行定向测试并确认失败。
5. 在 Adapter 仅保存白名单安全码和统一安全文案。
6. 在仓储增加 `saveReconciliationResultUnknown`，从当前错误中提取首次证据并合并核对时间和状态。
7. 修改 Worker 的远端标记分支使用合并方法。
8. 运行 Adapter、Worker 和仓储定向测试。

## Task 4：事务化人工重试

**修改：**

- `packages/db/src/integration/repositories.integration.test.ts`
- `packages/db/src/repositories/approval-repository.ts`

1. 写集成测试覆盖：合法 `no_change` 创建一个新 `miaoshou_edit` 任务；新任务无远端标记并复用原审批 ID。
2. 增加拒绝测试：版本变化、非 no_change、旧任务无远端标记、已有运行任务。
3. 增加幂等/并发测试：重复请求只创建一个新任务。
4. 运行定向测试并确认失败。
5. 增加稳定冲突错误类与 `retryMiaoshouEditAfterNoChange(productId)`。
6. 事务内锁定产品、当前版本、最新审批、同步记录和旧任务，验证所有前置条件。
7. 使用 `miaoshou-edit:<approvalId>:manual-retry:<n>` 创建新业务键，更新产品/同步状态并写审计事件。
8. 运行仓储集成测试。

## Task 5：详情页写回状态投影

**修改：**

- `packages/contracts/src/read-models.ts`
- `apps/web/src/server/services/product-service.test.ts`
- `apps/web/src/server/services/product-service.ts`

1. 写投影测试覆盖未开始、排队、成功、明确失败、可重试 no_change、不可重试结果未知。
2. 运行测试并确认失败。
3. 在 `ApprovalPreviewV1` 增加 `miaoshouWriteback` 视图。
4. `preview` 查询最新审批、同步和妙手编辑任务；由服务端计算文案所需的安全状态和 `retryAllowed`。
5. 对兼容记录只接受完整组合：错误码 no_change + 旧任务 `needs_input` + `reconcile_failed` + 远端标记存在。
6. 运行服务测试及受影响的页面/fixture 测试。

## Task 6：人工重试 API 与前端交互

**新增：**

- `apps/web/src/app/api/v1/products/[productId]/retry-miaoshou-edit/route.test.ts`
- `apps/web/src/app/api/v1/products/[productId]/retry-miaoshou-edit/route.ts`

**修改：**

- `apps/web/src/components/review/approval-actions.safety.test.tsx`
- `apps/web/src/components/review/approval-actions.tsx`
- `apps/web/src/components/review/final-review.tsx`
- `apps/web/src/app/final-review.test.tsx`

1. 写路由测试：回环和同源检查、202 成功、稳定 409 冲突映射。
2. 写组件测试：各状态文案、只有 `retryAllowed` 才出现重试按钮、防重复点击、请求成功后进入排队状态。
3. 运行测试并确认失败。
4. 新增重试路由，调用仓储事务方法，不接受客户端提供的审批 ID 或任务 ID。
5. 扩展 `ReviewActions` 增加 `retryMiaoshouEdit`，把服务端写回视图传入 `ApprovalActions`。
6. 确认按钮只在 `not_started` 或确认尚未产生审批时显示；排队、成功和结果未知状态显示对应业务文案。
7. 运行 Web 定向测试和类型检查。

## Task 7：真实数据兼容与完整验证

1. 运行 Adapter、Worker、DB、Web 的全部相关测试。
2. 运行仓库 `typecheck`、`lint` 和适当范围的完整测试。
3. 使用项目启动脚本启动/复用 3000 服务。
4. 浏览器打开 `/products/prod_ms1tnmsvx2sxoh0r`，验证 5 张洗图快速显示且不重复。
5. 验证页面对现有兼容记录显示“妙手写回未生效，远端仍为原内容”和人工重试按钮。
6. 在不实际点击外部写回按钮的前提下完成 UI 验收；自动化测试负责证明点击只创建一个新本地任务。实际外部重试属于用户可见的外部写入，交付时由用户决定是否点击。
7. 运行 `git diff --check`，检查暂存范围，只提交本任务文件。

## 提交建议

- `test: cover miaoshou recovery and detail thumbnails`
- `feat: add safe miaoshou writeback recovery`
- 如测试与实现无法干净拆分，可合并为一个原子提交，但不得包含工作区既有改动。
