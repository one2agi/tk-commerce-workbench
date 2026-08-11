# 业务术语字典 (Domain Glossary)

> **版本**：v2.0.0（以真实代码重建）
> **面向对象**：产品经理、运营团队与开发团队

术语定义均对照真实代码（表名/端点/Job 类型），统一团队沟通基准。

---

## 1. 采集与来源领域 (Capture & Source)

| 术语名称 | 真实代码对应 | 业务含义说明 |
|:---|:---|:---|
| **本地采集** | `POST /api/v1/local-captures`（IngestLocalCapturesV3）→ `IngestService.ingestLocal` → `LocalCaptureRepository.save` | 通过 Chrome MV3 扩展从 1688 页抓取商品载荷并提交入库。**同步写库**：直接生成 `products`（`state_source='local_captured'`）+ `product_revisions`（草稿 v1），**不入队 Job、不写 `miaoshou_source_records`**（后者仅由 `ingest-links` 路径触发的 worker `miaoshou_collect` handler 写入）。不存在独立 `local_captures` 表。 |
| **源店铺** | `source_shops` 表 | 采集商品所归属的上游 1688/供应商店铺。 |
| **采集 Token** | `EXTENSION_TOKEN` / `verifyExtensionToken` | 扩展向 `/local-captures`、`/ingest-links` 提交时的 Bearer 鉴权。 |
| **版本协商** | `local-captures` 对 version 1/2 返回 `extension_upgrade_required` | 扩展过旧时强制升级到协议 v3。 |

---

## 2. 商品与选品领域 (Product & Catalog)

| 术语名称 | 真实代码对应 | 业务含义说明 |
|:---|:---|:---|
| **商品草稿版本** | `product_revisions`（`source_payload` + `working_draft` JSONB，`UNIQUE(product_id, draft_version)`） | 每轮自动化/手动修改产生一个不可变草稿版本，`draft_version` 单调递增。 |
| **分窗图集** | `assets` 的 `kind`（源图 `main/sku/detail` vs 处理图 `generated`）+ `chosen_role` | 界面按“源图 / 处理后图集”分开展示；处理图仅接受 `chosen_role ∈ {primary, angle, detail, sku}` 的合格资产。 |
| **质量/视觉评分** | `assets` 列 `clarity/visual_score/watermark_probability/collage_probability/non_product_probability/perceptual_hash` | 资产筛选评分体系，`state='ready'` 且无 `rejection_reason` 才进入渲染候选。 |
| **定价计算** | `pricing_calculate` Job + `pricing_runs` 表 + `@tk/domain/pricing` | 基于 `workspace_settings.pricing_defaults`（费率/尾数）+ 实时汇率算出最终 minor 价格。 |

---

## 3. 审批与妙手 ERP 回写领域 (Approval & Writeback)

| 术语名称 | 真实代码对应 | 业务含义说明 |
|:---|:---|:---|
| **审批快照** | `approval_snapshots` 表（`NULLS NOT DISTINCT` 五元组唯一约束） | 确认回写时冻结完整上架内容（标题/描述/属性/价格/图集顺序/模板版本），保证回写内容不可变、幂等。 |
| **确认妙手编辑** | `POST /api/v1/products/[id]/confirm-miaoshou-edit`（ConfirmMiaoshouEditV1） | **真实的“审批”入口**：生成 `approval_snapshot` + `miaoshou_sync`，返回 `{approvalSnapshotId, syncId}`。`orderedFinalAssetIds` 为空 → `503 approval_mapping_not_ready`。 |
| **审批失效** | `approvalInvalidation.invalidateInTransaction`，内建于 `draft` 更新与 `rerun` 事务 | 商品再次被编辑或重跑下游流程时，自动置 `state_approval='unapproved'` 并清理回写前置产物。**不存在独立失效端点。** |
| **妙手回写状态** | `miaoshou_syncs` 表（`UNIQUE(approval_snapshot_id)`，`remote_detail_id`/`last_reconciled_at`/`error`） | 一次审批对应一次回写同步，记录远端明细 ID 与最近对账时间。 |
| **无变更重试** | `POST /api/v1/products/[id]/retry-miaoshou-edit` | 远端已成功但本地状态丢失时安全恢复；`retry_not_allowed/revision_changed/writeback_in_progress` → 409。 |
| **批量确认/重试** | `POST /api/v1/products/batch-actions`（`confirm_miaoshou_edit`/`retry_from_failure`） | 一次最多 50 个商品，逐项返回 `{productId, ok, code?}`。 |

---

## 4. 任务与自动化引擎领域 (Task & Automation Engine)

| 术语名称 | 真实代码对应 | 业务含义说明 |
|:---|:---|:---|
| **下游重跑** | `POST /api/v1/products/[id]/rerun`（RerunDownstreamV1，`startNode: listing|template|canvas`） | 从指定节点重跑自动化，按 `buildRerunInvalidation` 失效下游节点，保留上游；canvas 重试上限 30。 |
| **任务操作** | `POST /api/v1/tasks/[taskId]/actions`（`pause/resume/cancel/retry`） | 对队列任务执行暂停/恢复/取消/重试。 |
| **Canvas 配额** | `canvas_daily_reservations` 表（`PRIMARY KEY(day_key, slot)`）+ `workspace_settings.max_canvas_runs_per_day`（默认 50） | 单日渲染槽位上限。 |
| **Worker 租约** | `jobs` 表 `lease_token/owner/lease_expires_at/last_heartbeat_at` | 多 Worker 原子抢占任务并续约，防止重复执行。 |
| **PGlite** | `@electric-sql/pglite` | 嵌入式 Postgres，用于 `packages/db` 集成测试与本地快速运行。 |
