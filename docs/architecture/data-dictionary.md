# 数据模型与数据库字典 (Data Dictionary & DB Schema)

> **版本**：v2.0.0（以真实源码重建）
> **唯一权威**：`packages/db/src/migrations/0000_initial.ts`（`INITIAL_SQL`）
> **数据库**：PostgreSQL 16+ / PGlite 0.5.x
> **映射类型**：`packages/db/src/schema/index.ts`

本文档逐表记录 **22 张真实数据库表**。字段、类型、默认值、约束全部直接转录自 `0000_initial.ts`，未做任何演绎。

---

## 1. 表清单（22 张）

| # | 表名 | 职责 | 关键外键 |
|:--|:---|:---|:---|
| 1 | `local_operators` | 本地操作员 | - |
| 2 | `source_shops` | 上游 1688 源店铺 | → `local_operators` |
| 3 | `products` | 主商品 | → `local_operators` |
| 4 | `product_revisions` | 商品不可变版本 | → `products` |
| 5 | `miaoshou_source_records` | 妙手采集/回写履历 | → `products` |
| 6 | `skus` | SKU 变体 | → `products`, `product_revisions` |
| 7 | `sku_dimensions` | SKU 规格尺寸 | → `skus` |
| 8 | `assets` | 媒体资产（源图/处理图/生成图） | → `products`, `product_revisions` |
| 9 | `listing_drafts` | 刊登草稿 | → `products`, `product_revisions` |
| 10 | `listing_generation_runs` | 刊登生成运行记录 | → `products`, `product_revisions` |
| 11 | `pricing_runs` | 定价计算运行记录 | → `products`, `product_revisions` |
| 12 | `exchange_rate_snapshots` | 汇率快照 | - |
| 13 | `automation_runs` | 自动化流程运行 | → `product_revisions` |
| 14 | `canvas_runs` | Canvas 图像渲染任务 | → `products`, `product_revisions` |
| 15 | `canvas_daily_reservations` | Canvas 每日配额槽位 | - |
| 16 | `approval_snapshots` | 审批快照 | → `products`, `product_revisions` |
| 17 | `miaoshou_syncs` | 妙手回写同步状态 | → `approval_snapshots` |
| 18 | `jobs` | 异步任务队列 | - |
| 19 | `worker_instances` | Worker 实例注册 | - |
| 20 | `audit_events` | 审计事件 | - |
| 21 | `templates` | Canvas 渲染模板 | - |
| 22 | `workspace_settings` | 工作区配置（单行） | - |

---

## 2. 逐表字段定义（源自真实 SQL）

### 2.1 `local_operators`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 操作员 ID |
| `handle` | `TEXT` | UNIQUE NOT NULL | 登录 Handle |
| `display_name` | `TEXT` | NOT NULL | 显示名 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |

### 2.2 `source_shops`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 店铺 ID |
| `operator_id` | `TEXT` | NOT NULL REFERENCES local_operators(id) | 归属操作员 |
| `handle` | `TEXT` | NOT NULL | 店铺 Handle |
| `display_name` | `TEXT` | NOT NULL | 店铺显示名 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **约束** | | `UNIQUE (operator_id, handle)` | |

### 2.3 `products`（核心商品表）
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 商品 ID |
| `operator_id` | `TEXT` | NOT NULL REFERENCES local_operators(id) | 归属操作员 |
| `source_url` | `TEXT` | NOT NULL | 源商品 URL |
| `source_item_id` | `TEXT` | NULLABLE | 源商品条目 ID（唯一索引见下） |
| `locale` | `TEXT` | DEFAULT 'th-TH' | 目标地区 |
| `currency` | `TEXT` | DEFAULT 'THB' | 目标币种 |
| `canonical_success_detail_id` | `TEXT` | NULLABLE | 妙手正式成功明细 ID |
| `state_automation` | `TEXT` | DEFAULT 'not_started' | 自动化流程状态 |
| `state_asset_archive` | `TEXT` | DEFAULT 'pending' | 资产归档状态 |
| `state_listing` | `TEXT` | DEFAULT 'pending' | 刊登状态 |
| `state_canvas` | `TEXT` | DEFAULT 'not_started' | 图像渲染状态 |
| `state_approval` | `TEXT` | DEFAULT 'unapproved' | 审批状态 |
| `state_miaoshou_edit` | `TEXT` | DEFAULT 'not_started' | 妙手编辑状态 |
| `state_source` | `TEXT` | DEFAULT 'not_started' | 源数据采集状态 |
| `version` | `BIGINT` | DEFAULT 1 | 乐观锁版本 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **索引** | | `UNIQUE (operator_id, source_item_id) WHERE source_item_id IS NOT NULL` | 稳定商品身份 |

> 注意：**7 个独立状态列**（automation / asset_archive / listing / canvas / approval / miaoshou_edit / source）取代任何单一“商品状态”字段，这是本项目状态机的真实形态。

### 2.4 `product_revisions`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 版本 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `draft_version` | `INTEGER` | NOT NULL | 草稿版本号 |
| `source_title` | `TEXT` | NULLABLE | 源标题 |
| `source_payload` | `JSONB` | DEFAULT '{}' | 源数据完整载荷（详情明细+图集） |
| `working_draft` | `JSONB` | DEFAULT '{}' | 工作草稿（pricingInputs/templateMatch/imageSelection/finalAssetOrder 等） |
| `version` | `BIGINT` | DEFAULT 1 | 乐观锁版本 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **约束** | | `UNIQUE (product_id, draft_version)` | 版本号单调递增 |

### 2.5 `miaoshou_source_records`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 履历 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 关联商品 |
| `source_item_id` | `TEXT` | NOT NULL | 源条目 ID |
| `fetch_detail_id` | `TEXT` | NULLABLE | 抓取明细 ID |
| `skipped_detail_id` | `TEXT` | NULLABLE | 跳过明细 ID |
| `canonical_success_detail_id` | `TEXT` | NULLABLE | 正式成功明细 ID |
| `failure_reason` | `TEXT` | NULLABLE | 失败原因 |
| `fetched_payload` | `JSONB` | DEFAULT '{}' | 抓取载荷 |
| `state` | `TEXT` | DEFAULT 'not_started' | 状态 |
| `version` | `BIGINT` | DEFAULT 1 | 乐观锁版本 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |

### 2.6 `skus`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | SKU ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | REFERENCES product_revisions(id) ON DELETE SET NULL | 归属版本 |
| `sku_key` | `TEXT` | NOT NULL | SKU 稳定键 |
| `attributes` | `JSONB` | DEFAULT '{}' | 变体属性（颜色/尺码等） |
| `price_minor` | `TEXT` | NULLABLE | 价格（minor 字符串） |
| `price_currency` | `TEXT` | NULLABLE | 币种 |
| `stock` | `INTEGER` | NULLABLE | 库存 |
| `weight_value` | `TEXT` | NULLABLE | 重量值 |
| `weight_unit` | `TEXT` | NULLABLE | 重量单位 |
| `dimensions` | `JSONB` | NULLABLE | 尺寸 |
| `image_url` | `TEXT` | NULLABLE | 变体图 |
| `version` | `BIGINT` | DEFAULT 1 | 乐观锁版本 |
| **约束** | | `UNIQUE (product_id, sku_key)` | |

### 2.7 `sku_dimensions`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 记录 ID |
| `sku_id` | `TEXT` | NOT NULL REFERENCES skus(id) ON DELETE CASCADE | 归属 SKU |
| `name` | `TEXT` | NOT NULL | 维度名 |
| `value` | `TEXT` | NOT NULL | 维度值 |

### 2.8 `assets`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 资产 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | REFERENCES product_revisions(id) ON DELETE SET NULL | 归属版本 |
| `remote_url` | `TEXT` | NOT NULL | 远端 URL |
| `kind` | `TEXT` | NOT NULL | 类型：`main`/`sku`/`detail`/`generated` 等（见 pipeline 写入） |
| `state` | `TEXT` | DEFAULT 'pending' | `pending`/`ready`/`rejected` |
| `width` | `INTEGER` | NULLABLE | 宽度 |
| `height` | `INTEGER` | NULLABLE | 高度 |
| `sha256` | `TEXT` | NULLABLE | 内容寻址哈希 |
| `local_path` | `TEXT` | NULLABLE | 本地归档路径 |
| `extension` | `TEXT` | NULLABLE | 扩展名 |
| `perceptual_hash` | `TEXT` | NULLABLE | 感知哈希（查重） |
| `clarity` | `DOUBLE PRECISION` | NULLABLE | 清晰度分数 |
| `duplicate_distance` | `INTEGER` | NULLABLE | 查重距离 |
| `watermark_probability` | `DOUBLE PRECISION` | NULLABLE | 水印概率 |
| `collage_probability` | `DOUBLE PRECISION` | NULLABLE | 拼图概率 |
| `non_product_probability` | `DOUBLE PRECISION` | NULLABLE | 非商品概率 |
| `visual_score` | `DOUBLE PRECISION` | NULLABLE | 视觉评分 |
| `chosen_role` | `TEXT` | NULLABLE | 选中角色：`primary`/`angle`/`detail`/`sku` |
| `rejection_reason` | `TEXT` | NULLABLE | 淘汰原因 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **索引** | | `UNIQUE (revision_id, remote_url) WHERE revision_id IS NOT NULL` | |

### 2.9 `listing_drafts`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 草稿 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE | 归属版本 |
| `draft_version` | `INTEGER` | NOT NULL | 版本号 |
| `target_locale` | `TEXT` | NOT NULL | 目标地区 |
| `style` | `TEXT` | NOT NULL | 文案风格 |
| `title` | `TEXT` | NULLABLE | 生成标题 |
| `description` | `TEXT` | NULLABLE | 生成描述 |
| `attributes` | `JSONB` | DEFAULT '[]' | 生成属性 |
| `provider` | `TEXT` | NULLABLE | `rules`/`llm` |
| `model` | `TEXT` | NULLABLE | 模型名 |
| `fallback_used` | `BOOLEAN` | DEFAULT false | 是否降级 fallback |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **索引** | | `UNIQUE (revision_id, draft_version)` | |

### 2.10 `listing_generation_runs`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 运行 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE | 归属版本 |
| `draft_version` | `INTEGER` | NOT NULL | 版本号 |
| `state` | `TEXT` | DEFAULT 'pending' | 状态 |
| `provider` | `TEXT` | NULLABLE | 提供方 |
| `model` | `TEXT` | NULLABLE | 模型 |
| `attempts` | `INTEGER` | DEFAULT 0 | 重试次数 |
| `last_error` | `JSONB` | NULLABLE | 最近错误 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |

### 2.11 `pricing_runs`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 计算 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE | 归属版本 |
| `draft_version` | `INTEGER` | NOT NULL | 版本号 |
| `state` | `TEXT` | DEFAULT 'pending' | 状态 |
| `breakdown` | `JSONB` | DEFAULT '{}' | 定价拆解明细 |
| `final_price_minor` | `TEXT` | NULLABLE | 最终价（minor 字符串） |
| `final_currency` | `TEXT` | NULLABLE | 最终币种 |
| `ending` | `TEXT` | NULLABLE | 定价尾数策略 |
| `exchange_rate_snapshot_id` | `TEXT` | NULLABLE | 使用的汇率快照 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **索引** | | `UNIQUE (revision_id, draft_version)` | |

### 2.12 `exchange_rate_snapshots`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 快照 ID |
| `base` | `TEXT` | NOT NULL | 基准币种（CNY） |
| `target` | `TEXT` | NOT NULL | 目标币种（THB 等） |
| `rate` | `TEXT` | NOT NULL | 汇率（字符串） |
| `source` | `TEXT` | NOT NULL | 来源：`manual`/`provider` |
| `observed_at` | `TIMESTAMPTZ` | NOT NULL | 观察时间 |
| `is_stale` | `BOOLEAN` | DEFAULT false | 是否过期 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |

### 2.13 `automation_runs`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 运行 ID |
| `revision_id` | `TEXT` | NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE | 归属版本 |
| `processing_version` | `INTEGER` | NOT NULL | 处理流程版本 |
| `state` | `TEXT` | DEFAULT 'queued' | 状态 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **约束** | | `UNIQUE (revision_id, processing_version)` | |

### 2.14 `canvas_runs`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 渲染任务 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE | 归属版本 |
| `template_id` | `TEXT` | NOT NULL | 模板 ID |
| `template_version` | `INTEGER` | NOT NULL | 模板版本 |
| `state` | `TEXT` | DEFAULT 'not_started' | 状态 |
| `workflow_id` | `TEXT` | NULLABLE | 外部工作流 ID |
| `workflow_version` | `INTEGER` | NULLABLE | 工作流版本 |
| `remote_task_id` | `TEXT` | NULLABLE | 外部任务回调 ID |
| `outputs` | `JSONB` | DEFAULT '[]' | 产出资产 ID 列表 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **索引** | | `UNIQUE (revision_id, template_version)` | |

### 2.15 `canvas_daily_reservations`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `day_key` | `DATE` | PK (复合) | 日期 |
| `slot` | `INTEGER` | PK (复合), CHECK (slot > 0) | 槽位序号 |
| `run_key` | `TEXT` | NOT NULL | 预约的 Run 凭证 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **约束** | | `PRIMARY KEY (day_key, slot)`；`UNIQUE (day_key, run_key)` | 每日配额上限 |

### 2.16 `approval_snapshots`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 快照 ID |
| `product_id` | `TEXT` | NOT NULL REFERENCES products(id) ON DELETE CASCADE | 归属商品 |
| `revision_id` | `TEXT` | REFERENCES product_revisions(id) ON DELETE SET NULL | 归属版本（可空） |
| `draft_version` | `INTEGER` | NOT NULL | 版本号 |
| `listing_run_id` | `TEXT` | NOT NULL | 关联刊登运行 |
| `pricing_run_id` | `TEXT` | NULLABLE（迁移后） | 关联定价运行 |
| `template_version` | `INTEGER` | NOT NULL | 模板版本 |
| `ordered_final_asset_ids` | `JSONB` | DEFAULT '[]' | 最终图集顺序 |
| `source_platform` | `TEXT` | DEFAULT '1688' | 源平台 |
| `source_canonical_url` | `TEXT` | NOT NULL | 源规范 URL |
| `source_item_id` | `TEXT` | NOT NULL | 源条目 ID |
| `canonical_success_detail_id` | `TEXT` | NULLABLE（迁移后） | 妙手成功明细 |
| `locale` | `TEXT` | NOT NULL | 目标地区 |
| `currency` | `TEXT` | NOT NULL | 目标币种 |
| `title` | `TEXT` | NOT NULL | 冻结标题 |
| `description` | `TEXT` | NOT NULL | 冻结描述 |
| `attributes` | `JSONB` | DEFAULT '[]' | 冻结属性 |
| `item_number` | `TEXT` | NULLABLE | 货号 |
| `price_minor` | `TEXT` | NULLABLE（迁移后） | 冻结价格 |
| `price_currency` | `TEXT` | NULLABLE（迁移后） | 冻结币种 |
| `stock` | `INTEGER` | NULLABLE（迁移后） | 冻结库存 |
| `weight_kg` | `TEXT` | NULLABLE（迁移后） | 冻结重量 |
| `dimensions` | `JSONB` | NULLABLE | 冻结尺寸 |
| `skus` | `JSONB` | DEFAULT '[]' | 冻结 SKU 列表 |
| `state` | `TEXT` | DEFAULT 'unapproved' | 快照状态 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **约束** | | `UNIQUE NULLS NOT DISTINCT (product_id, revision_id, draft_version, listing_run_id, pricing_run_id)` | 幂等防重 |

### 2.17 `miaoshou_syncs`（回写同步状态）
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 同步 ID |
| `approval_snapshot_id` | `TEXT` | NOT NULL REFERENCES approval_snapshots(id) ON DELETE CASCADE | 关联审批快照 |
| `state` | `TEXT` | DEFAULT 'not_started' | 回写状态 |
| `remote_detail_id` | `TEXT` | NULLABLE | 妙手远端明细 ID |
| `last_reconciled_at` | `TIMESTAMPTZ` | NULLABLE | 最近对账时间 |
| `error` | `JSONB` | NULLABLE | 错误信息 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **约束** | | `UNIQUE (approval_snapshot_id)` | 一快照一同步 |

### 2.18 `jobs`（任务队列）
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | Job ID |
| `kind` | `TEXT` | NOT NULL | 任务类型（如 `listing_generate`/`canvas_generate`） |
| `business_key` | `TEXT` | NOT NULL | 业务键 |
| `idempotency_key` | `TEXT` | NOT NULL | 幂等键 |
| `payload` | `JSONB` | NOT NULL | 任务载荷 |
| `batch_key` | `TEXT` | NULLABLE | 批处理键 |
| `pause_reason` | `TEXT` | NULLABLE | 暂停原因 |
| `status` | `TEXT` | DEFAULT 'queued' | `queued`/`running`/… |
| `attempt` | `INTEGER` | DEFAULT 0 | 已尝试次数 |
| `max_attempts` | `INTEGER` | DEFAULT 3 | 最大尝试次数 |
| `next_attempt_at` | `TIMESTAMPTZ` | NULLABLE | 下次重试时间 |
| `owner` | `TEXT` | NULLABLE | 抢占的 Worker |
| `lease_token` | `TEXT` | NULLABLE | 租约令牌 |
| `lease_expires_at` | `TIMESTAMPTZ` | NULLABLE | 租约到期 |
| `last_heartbeat_at` | `TIMESTAMPTZ` | NULLABLE | 心跳时间 |
| `remote_task_id` | `TEXT` | NULLABLE | 外部任务 ID |
| `error` | `JSONB` | NULLABLE | 错误信息 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now() | 更新时间 |
| **约束** | | `UNIQUE (kind, business_key)` | 幂等防重 |

### 2.19 `worker_instances`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 实例 ID |
| `label` | `TEXT` | NOT NULL | 实例标识 |
| `last_seen_at` | `TIMESTAMPTZ` | DEFAULT now() | 最近心跳 |

### 2.20 `audit_events`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 审计 ID |
| `actor_type` | `TEXT` | NOT NULL | 操作者类型（`operator`/`worker`/`system`） |
| `actor_id` | `TEXT` | NULLABLE | 操作者 ID |
| `action` | `TEXT` | NOT NULL | 动作（如 `product_draft_overrides_updated`） |
| `target_kind` | `TEXT` | NOT NULL | 目标类型（`product`/`product_revision`） |
| `target_id` | `TEXT` | NOT NULL | 目标 ID |
| `payload` | `JSONB` | DEFAULT '{}' | 详情载荷 |
| `redacted` | `BOOLEAN` | DEFAULT true | 是否已脱敏 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 记录时间 |

### 2.21 `templates`
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `TEXT` | PK | 模板 ID |
| `name` | `TEXT` | NOT NULL | 模板名 |
| `category_rules` | `JSONB` | DEFAULT '[]' | 类目匹配规则 |
| `reference_asset_ids` | `JSONB` | DEFAULT '[]' | 参考资产 ID |
| `prompt_fragment` | `TEXT` | DEFAULT '' | 提示词片段 |
| `target_locale` | `TEXT` | NOT NULL | 目标地区 |
| `visual_style` | `TEXT` | DEFAULT '' | 视觉风格 |
| `enabled` | `BOOLEAN` | DEFAULT true | 是否启用 |
| `version` | `INTEGER` | DEFAULT 1 | 模板版本 |
| `created_at` | `TIMESTAMPTZ` | DEFAULT now() | 创建时间 |
| **迁移后** | `template_key` | TEXT NOT NULL（UNIQUE (template_key, version)） | 模板稳定键 |

### 2.22 `workspace_settings`（单行配置表）
| 字段 | 类型 | 约束/默认 | 说明 |
|:---|:---|:---|:---|
| `id` | `INTEGER` | PK | 固定为单行 |
| `default_locale` | `TEXT` | DEFAULT 'th-TH' | 默认地区 |
| `default_currency` | `TEXT` | DEFAULT 'THB' | 默认币种 |
| `external_adapter_mode` | `TEXT` | DEFAULT 'mock' | `mock`/`live` |
| `miaoshou_configured` | `BOOLEAN` | DEFAULT false | 是否配置妙手 |
| `canvas_configured` | `BOOLEAN` | DEFAULT false | 是否配置 Canvas |
| `llm_configured` | `BOOLEAN` | DEFAULT false | 是否配置 LLM |
| `exchange_rate_configured` | `BOOLEAN` | DEFAULT false | 是否配置汇率 |
| `worker_concurrency` | `INTEGER` | DEFAULT 1 | Worker 并发数 |
| `max_canvas_runs_per_day` | `INTEGER` | DEFAULT 50 | 每日 Canvas 上限 |
| `asset_root` | `TEXT` | DEFAULT './var/assets' | 资产根目录 |
| `worker_paused` | `BOOLEAN` | DEFAULT false（迁移后） | Worker 暂停开关 |
| `version` | `BIGINT` | DEFAULT 1（迁移后） | 乐观锁版本 |
| `pricing_defaults` | `JSONB` | DEFAULT 定价默认值（迁移后） | 定价参数默认 |
| `provider_options` | `JSONB` | DEFAULT（迁移后） | 提供方选项 |
| `retry_policy` | `JSONB` | DEFAULT（迁移后） | 重试策略 |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT now()（迁移后） | 更新时间 |

---

## 3. 真实数据流与写入路径（取自 `PipelineRepository`）

`PipelineRepository` 不是独立表，而是跨表门面，按节点顺序写入：

| 节点 | 写入的表 | 更新 products 状态列 |
|:---|:---|:---|
| `collect` | `local_operators`, `products`, `product_revisions`, `miaoshou_source_records` | `state_source = 'success'` |
| `archive` | `assets` | `state_asset_archive` |
| `listing` | `listing_drafts` | `state_listing = 'ready'` |
| `pricing` | `pricing_runs` | - |
| `exchangeRate` | `exchange_rate_snapshots`（source=provider） | - |
| `templates` | 读 `templates` | - |
| `images` | 读 `assets` | - |
| `canvas` | `canvas_runs` + `assets`(kind=generated) | `state_canvas` |
| `finalPreview` | 读 `product_revisions` | - |

---

## 4. 说明

- **金额**：`price_minor` 等一律为 **TEXT 字符串的 minor 整数**（如 `"2500"` = 25.00），转换由 `PipelineRepository.minorToMajor` 完成，避免浮点误差。
- **稳定身份**：`products.operator_id + source_item_id` 唯一；历史重复行被迁移为 `source_item_id = NULL`。
- **幂等**：`approval_snapshots` 的 `NULLS NOT DISTINCT` 五元组唯一约束，保证同一审批组合只能存在一份快照。
