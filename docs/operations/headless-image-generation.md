# Headless Image Generation Operations

本文档描述无 Canvas（纯 API 调用）图片生成流水线在生产环境的操作指南。

## 核心概念

Headless 图片生成绕过 Canvas 工作流界面，通过直接调用图像生成 API（OpenAI-compatible API）完成图片生成。

- **规划阶段**：根据商品品类和输入图片，使用 LLM 生成每张输出图的提示词。
- **生成阶段**：每个输出槽独立调用图像生成 API，互不干扰。
- **存档阶段**：每个槽独立将生成的图片存档到本地内容寻址存储。
- **恢复能力**：任意槽失败不影响其他槽；重启后可从中断处继续而不重复付费。

## 路由切换

```bash
# 使用 Headless 直接 API（需要显式开启）
IMAGE_GENERATION_PATH=headless

# 使用 Canvas 工作流（当前默认，兼容现有部署）
IMAGE_GENERATION_PATH=canvas  # 需要 CANVAS_BASE_URL
```

**未指定时保持 `IMAGE_GENERATION_PATH=canvas`，避免现有部署升级后突然切换链路。** 完成 Headless 的 Planner 和图片 Provider 配置后，再显式改为 `headless`。

在 `IMAGE_GENERATION_PATH=headless` 模式下，Canvas 服务可以完全关闭。

## 必需的环境变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `IMAGE_GENERATION_PATH` | 路由模式：`canvas` 或 `headless` | `headless` |
| `IMAGE_GENERATION_BASE_URL` | 图像生成 API 基础 URL | `https://api.openai.com/v1` |
| `IMAGE_GENERATION_API_KEY` | API 密钥 | `sk-...` |
| `IMAGE_GENERATION_MODEL` | 模型名称 | `dall-e-3` 或提供商模型名 |
| `IMAGE_GENERATION_INPUT_MAX` | 最大输入图片数 | `6` |
| `IMAGE_GENERATION_OUTPUT_MAX` | 最大输出图片数 | `8` |

Canvas 相关变量（`CANVAS_BASE_URL` 等）仅在 `IMAGE_GENERATION_PATH=canvas` 时使用。

## 状态检查

### 查看商品生成状态

1. 打开商品详情页 `/products/<productId>`
2. 查看"智能洗图"面板的状态标签

状态流转：

```
not_started → planning → generating → partial/succeeded/failed
                                      ↓
                                  succeeded（全部成功）
                                  partial（部分成功，可接受当前结果）
                                  failed（全部失败，可重试）
```

### 查看批次详情

在商品详情页，批次 ID 显示在面板头部。数据库查询：

```sql
-- 查看批次概览
SELECT id, state, requested_output_count,
       array_length(accepted_asset_ids, 1) as accepted_count
FROM image_generation_batches
WHERE product_id = '<productId>';

-- 查看各槽状态
SELECT id, slot_number, state, attempt, error, archived_asset_id
FROM image_generation_slots
WHERE batch_id = '<batchId>'
ORDER BY slot_number;
```

## 重试单个槽

当某个槽失败而其他槽成功时，可以单独重试失败的槽：

1. 在商品详情页的"智能洗图"面板中，找到失败的槽卡片。
2. 点击"重新生成这张"按钮。
3. 系统仅重试该槽，不影响已成功的槽。

API 方式：

```bash
curl -X PATCH "http://127.0.0.1:3000/api/v1/products/<productId>/image-generations/<batchId>/slots/<slotId>" \
  -H "Content-Type: application/json" \
  -d '{"action":"retry","batchId":"<batchId>","slotId":"<slotId>"}'
```

## 接受部分结果

当批次处于 `partial` 状态（部分槽成功，部分失败）时：

1. 在商品详情页点击"排除这张"按钮排除失败的槽。
2. 系统更新接受状态为仅包含成功的槽。
3. 可以基于部分成功的结果继续后续流程（标题生成、定价、妙手写回）。

注意：排除后的槽不能恢复。

## 识别配置失败

| 现象 | 可能原因 | 下一步 |
|---|---|---|
| 所有槽都失败 | `IMAGE_GENERATION_API_KEY` 未设置或无效 | 检查环境变量和 API 额度 |
| 槽一直pending | 网络问题或 API 响应超时（默认30s） | 检查 `IMAGE_GENERATION_BASE_URL` 连通性 |
| 槽状态为 failed 但 error 为空 | 存档验证失败（尺寸为零或格式不支持） | 检查生成的图片是否符合要求 |
| 规划阶段卡住 | `IMAGE_GENERATION_MODEL` 不支持结构化输出 | 切换到支持 JSON 的模型 |

## 确认图片已存档

成功生成的图片会存档到本地内容寻址存储：

```sql
-- 查找某批次生成的存档图片
SELECT a.id, a.sha256, a.local_path, a.width, a.height
FROM assets a
JOIN image_generation_slots s ON s.archived_asset_id = a.id
WHERE s.batch_id = '<batchId>'
  AND a.state = 'ready';
```

`local_path` 字段为本地存档路径，`sha256` 为内容哈希（可用于验证完整性）。

## 重启恢复

Headless 图片生成设计为重启安全：

- **intent 持久化**：调用图像生成 API 前会先保存 `remoteTaskId`。如果 worker 在调用期间崩溃，重启后会先查询结果而不是重新提交。
- **槽独立恢复**：每个槽独立存储自己的 `remoteTaskId`。一个槽失败不影响其他槽。
- **幂等性**：槽使用 `slot:<batchId>:<slotNumber>` 作为幂等键，provider 端不会因重复提交产生副作用。

如果 worker 在槽生成期间崩溃：

1. 重启 worker。
2. 系统自动恢复所有未完成的槽（状态为 `queued` 或有待处理 `remoteTaskId`）。
3. 已成功的槽不受影响。

## Miaoshou 写回（Canvas-Off）

即使在 `IMAGE_GENERATION_PATH=headless` 模式下，妙手写回仍然正常工作：

1. 在商品详情页确认生成的图片。
2. 点击"确认写回妙手"。
3. 系统使用已接受的本地存档图片，通过妙手 API 更新商品详情。

写回不依赖 Canvas 服务。

## 性能考量

- 每个槽独立调用图像生成 API，可以并行处理（`WORKER_CONCURRENCY` 控制）。
- 建议 `WORKER_CONCURRENCY` 设置为 2-4，避免 API 限流。
- 存档阶段会下载和验证图片，设置合理的 `ASSET_ROOT` 磁盘空间。
