# REST API 接口契约（API Contracts）

> **版本**：v2.0.0（以真实 route.ts 重建）
> **唯一权威**：`apps/web/src/app/api/v1/**/route.ts`
> **Base URL**：`/api/v1`

本文档逐端点转录真实 route.ts 的方法、状态码与请求/响应结构。**所有信息直接取自源码，未做演绎。**

---

## 0. 端点总览（17 个）

| # | 方法 | 路径 | 鉴权 | 典型成功状态 |
|:--|:---|:---|:---|:---|
| 1 | `POST` | `/api/v1/local-captures` | EXTENSION_TOKEN | 201 |
| 2 | `POST` | `/api/v1/ingest-links` | EXTENSION_TOKEN | 202 |
| 3 | `GET` | `/api/v1/products` | loopback | 200 |
| 4 | `GET` | `/api/v1/products/[productId]` | loopback | 200 |
| 5 | `PATCH` | `/api/v1/products/[productId]/draft` | loopback + 浏览器突变防护 | 200 |
| 6 | `POST` | `/api/v1/products/[productId]/rerun` | loopback + 浏览器突变防护 | 202 |
| 7 | `POST` | `/api/v1/products/[productId]/confirm-miaoshou-edit` | loopback + 浏览器突变防护 | 202 |
| 8 | `POST` | `/api/v1/products/[productId]/retry-miaoshou-edit` | loopback + 浏览器突变防护 | 202 |
| 9 | `POST` | `/api/v1/products/batch-actions` | loopback + 浏览器突变防护 | 202 |
| 10 | `POST` | `/api/v1/automation-runs` | loopback + 浏览器突变防护 | 202 |
| 11 | `GET` | `/api/v1/tasks` | loopback | 200 |
| 12 | `POST` | `/api/v1/tasks/[taskId]/actions` | loopback + 浏览器突变防护 | 202 |
| 13 | `GET` | `/api/v1/miaoshou-syncs` | loopback | 200 |
| 14 | `GET`/`POST`/`PATCH` | `/api/v1/templates` | loopback + 浏览器突变防护 | 200/201/200 |
| 15 | `GET`/`PATCH` | `/api/v1/settings` | loopback + 浏览器突变防护 | 200/200 |
| 16 | `GET` | `/api/v1/assets/[assetId]/content` | loopback | 200（图片流） |
| 17 | `GET` | `/api/v1/source-images` | loopback | 200（图片流） |

> 源图存在两条读取路径：已归档资产走 `/api/v1/assets/[assetId]/content`（本地安全代理）；未归档的远端源图由 `product-service.ts:248` 通过 `sourceImageProxyPath(url)` 生成 `/api/v1/source-images?url=...` 的可见 URL。

---

## 1. 通用安全约束（来自 `server/auth/loopback.ts`）

- **`rejectNonLoopback`**：所有端点仅接受回环地址（127.0.0.1/localhost 及其别名）请求。
- **`rejectUnsafeBrowserMutation`**：写操作端点（PATCH/POST 突变）额外校验浏览器来源，拒绝跨站突变。
- **`EXTENSION_TOKEN` 校验**：`local-captures` 与 `ingest-links` 校验 `Authorization: Bearer <token>`。

---

## 2. 端点明细

### 2.1 `POST /api/v1/local-captures` — 扩展采集入库
- **鉴权**：`Authorization: Bearer <EXTENSION_TOKEN>`（失败 → `401 {error:"unauthorized"}`）
- **版本协商**：请求体 `version` 为 1/2 → `409 {error:"extension_upgrade_required", requiredVersion:3}`；`version:3` 走 `IngestLocalCapturesV3` zod 校验。
- **失败**：`400 {error:"invalid_request"}`
- **成功**：`201`，返回 `IngestService.ingestLocal(parsed.data)` 结果。

### 2.2 `POST /api/v1/ingest-links` — 手动链接入库
- **鉴权**：EXTENSION_TOKEN（失败 → 401）
- **Body**：`IngestLinksV1` zod 校验（失败 → `400 {error:"invalid_request"}`）
- **成功**：`202`，返回 `ingest` 结果。

### 2.3 `GET /api/v1/products` — 商品列表
- **查询参数**：无（源码未定义分页/筛选参数）
- **成功**：`200`，返回 `ProductService.list()` 结果：`{ items: ProductPoolItemV1[] }`（对象包裹，非裸数组）。

### 2.4 `GET /api/v1/products/[productId]` — 商品详情
- **失败**：商品不存在 → `404 {error:"product_not_found"}`
- **成功**：`200`，返回 `ProductService.get(productId)` 完整结构。

### 2.5 `PATCH /api/v1/products/[productId]/draft` — 草稿覆盖更新
- **Body**：`UpdateProductOverridesV1` + `{ expectedDraftVersion: number, targetLocale?: string }`（失败 → `400 {error:"invalid_request"}`）
- **事务语义**（`createPgDraftPort`）：
  1. `SELECT ... FOR UPDATE` 锁定商品；
  2. 校验 `expectedDraftVersion` 等于当前 `max(draft_version)`，否则 → `409 draft_version_conflict`；
  3. 调用 `approvalInvalidation.invalidateInTransaction(..., "draft_overrides_updated")` **使审批失效**；
  4. 复制 `working_draft`，清空 `templateMatch/imageSelection/approvalPreview`，写入新 `product_revisions`（draft_version+1）；
  5. 复制非 `generated` 资产到新版本；
  6. 重置 `state_listing='pending'`、`state_canvas='not_started'`、`state_approval='unapproved'`、`state_miaoshou_edit='not_started'`；
  7. 写 `audit_events`（action=`product_draft_overrides_updated`）。
- **成功**：`200`，返回 `{ draftVersion, revisionId, approvalInvalidated: true }`。
- **冲突**：`409 approval_sync_in_progress`。

### 2.6 `POST /api/v1/products/[productId]/rerun` — 下游流程重跑
- **Body**：`RerunDownstreamV1`（含 `startNode`：`listing` | `template` | `canvas`；`expectedDraftVersion`；`revisionId`）
- **失效规则**（`buildRerunInvalidation`）：
  - `listing` → 失效 `[listing, template, canvas, approval]`，保留 `[collection, asset_archive]`
  - `template` → 失效 `[template, canvas, approval]`，保留 `[collection, asset_archive, listing]`
  - `canvas` → 失效 `[canvas, approval]`，保留 `[collection, asset_archive, listing, template]`
- **事务语义**：校验版本 → 失效审批 → 复制版本与资产 → 依据 `firstJob`（`listing→listing_generate` / `template→template_match` / `canvas→canvas_generate`）入队 Job（canvas 默认 `max_attempts=30`）→ 写审计。
- **失败**：`409 stale_draft_version` / `409 approval_sync_in_progress` / `500 rerun_failed`
- **成功**：`202`，返回 `{ accepted:true, jobId, revisionId, draftVersion, approvalInvalidated:true, invalidatedNodes }`。

### 2.7 `POST /api/v1/products/[productId]/confirm-miaoshou-edit` — 确认妙手编辑并回写
- **Body**：`ConfirmMiaoshouEditV1`（校验失败 → 400）
- **语义**：`confirmAndEnqueue` 生成 `approval_snapshot` + `miaoshou_sync` 并入队回写 Job。
- **失败**：`409 approval_conflict` / `409 approval_sync_in_progress` / `500 confirmation_failed`。
  - 注意：`orderedFinalAssetIds` 为空时，服务层用 `node assert` 抛 `AssertionError` → 归入 `500 confirmation_failed`；`503 approval_mapping_not_ready` 在**此端点不可达**（该 code 仅由 `batch-actions` 路由在预览不满足时作为逐项结果抛出）。
- **成功**：`202`，返回 `{ approvalSnapshotId, syncId }`。

### 2.8 `POST /api/v1/products/[productId]/retry-miaoshou-edit` — 无变更重试回写
- **语义**：`retryMiaoshouEditAfterNoChange(productId)`。
- **失败**：`409 retry_not_allowed` / `409 revision_changed` / `409 writeback_in_progress` / `500 miaoshou_retry_failed`
- **成功**：`202`，返回 `{ approvalSnapshotId, syncId, jobId }`。

### 2.9 `POST /api/v1/products/batch-actions` — 批量操作
- **Body**（zod）：
  ```json
  { "action": "confirm_miaoshou_edit" | "retry_from_failure", "productIds": ["..."] }
  ```
  `productIds` 1–50 个。
- **语义**：逐商品执行。`confirm_miaoshou_edit` 先查 `preview`（要求 `orderedFinalAssetIds` 非空，否则 `approval_mapping_not_ready`）；`retry_from_failure` 走 `enqueueProductRetry`。
- **成功**：`202`，返回 `{ results: [{ productId, ok, code? }] }`（逐项成败，不整体失败）。

### 2.10 `POST /api/v1/automation-runs` — 启动自动化
- **Body**：`StartAutomationV1` zod 校验（失败 → 400）
- **失败**：`404 revision_not_found` / `500 automation_start_failed`
- **成功**：`202`，返回 `service.start(parsed.data)` 结果。

### 2.11 `GET /api/v1/tasks` — 任务列表
- **查询参数**：无
- **成功**：`200`，返回 `TaskService.list()`。

### 2.12 `POST /api/v1/tasks/[taskId]/actions` — 任务操作
- **Body**：`{ action: "pause"|"resume"|"cancel"|"retry", reason?: string(≤200) }`
- **语义**：`service.act(taskId, action, reason)`；返回 false 时 → `409 {error:"task_action_not_allowed"}`
- **成功**：`202`，返回 `{ taskId, action, accepted:true }`。

### 2.13 `GET /api/v1/miaoshou-syncs` — 回写同步状态列表
- **成功**：`200`，返回 `{ items: MiaoshouSyncStatusV1[] }`。

### 2.14 `/api/v1/templates` — Canvas 模板管理
- **`GET`**：`200`，`TemplateService.list()`。
- **`POST`**（创建）：Body=`TemplateCreateBody`（`name/categoryRules/referenceAssetIds/promptFragment/targetLocale/visualStyle/enabled`）；`201`。
- **`PATCH`**（更新）：Body=`{ templateId, expectedVersion, ...可选字段 }`；版本冲突 → `409 {error:"template_version_conflict", actualVersion}`；`200`。

### 2.15 `/api/v1/settings` — 工作区设置
- **`GET`**：`200`，`SettingsService.get()`。
- **`PATCH`**：Body 含 `expectedVersion`（乐观锁）+ 可选字段（`defaultLocale/defaultCurrency/externalAdapterMode/workerConcurrency/maxCanvasRunsPerDay/assetRoot/pricingDefaults/providerOptions/retryPolicy`，全部 zod strict 校验）；版本冲突 → `409 {error:"settings_version_conflict", actualVersion}`；`200`。

### 2.16 `GET /api/v1/assets/[assetId]/content` — 资产内容读取（安全代理）
- **查询参数**：`variant=thumbnail`（可选；其他值 → `400 invalid_asset_variant`）
- **鉴权**：loopback only
- **安全校验**（源码 `createGetHandler`）：
  1. `assetId` 格式校验（`^[A-Za-z0-9][A-Za-z0-9:_-]{1,199}$`），否则 404；
  2. `realpath` + `assetRoot` 前缀校验，杜绝路径穿越（符号链接 → 404）；
  3. 扩展名白名单：`.jpg/.jpeg/.png/.webp/.gif`，否则 `415 unsupported_asset_type`。
- **成功**：`200` 图片流；`thumbnail` 用 sharp 生成 480×480 WebP（`private, max-age=86400`），原图 `private, max-age=300`，均带 `x-content-type-options: nosniff`。
- **失败**：`404 asset_not_found`。

### 2.17 `GET /api/v1/source-images` — 远端源图安全代理
- **查询参数**：`url`（必需；经 `parseAllowedSourceImageUrl` 校验，仅允许 1688 等白名单源，非法 → `400 invalid_source_image_url`）
- **鉴权**：loopback only
- **安全校验**（源码 `createGetHandler`）：
  1. 禁止跟随重定向（`redirect:"manual"`），3xx → `502 source_image_redirect_rejected`；
  2. 上游响应非 OK → `502 source_image_unavailable`；
  3. `Content-Type` 须以 `image/` 开头，否则 `415 unsupported_source_image_type`；
  4. 大小上限 `MAX_SOURCE_IMAGE_BYTES`（15MB），超限 → `413 source_image_too_large`。
- **成功**：`200` 图片流，带 `cache-control: private, max-age=300` 与 `x-content-type-options: nosniff`。

---

## 3. 说明

- 本清单**不含** `/approve`、`/invalidate-approval` 等端点——它们不存在于真实 route.ts。
- 所有写操作端点统一依赖回环同源检查 +（对浏览器来源的）突变防护，这是本项目“本地单机工作台 + 防 CSRF/防越权”的安全基线。
