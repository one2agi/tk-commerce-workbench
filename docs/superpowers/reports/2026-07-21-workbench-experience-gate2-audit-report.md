# Workbench Experience Repair — Gate 2 Audit Report

**日期：** 2026-07-21  
**范围：** 当前实现对照 `docs/superpowers/specs/2026-07-21-workbench-experience-repair-spec.md`、Gate 1 终点和对标产品 UI/功能方向。  
**结论：** Gate 2 审计完成；当前链路有真实能力，但产品化体验未达标。进入修复计划前，必须先完成 Gate 3 业务状态机和 Gate 4 商品工作台信息架构。

## 1. 审计基线

Gate 1 已确认的 MVP 终点：

```text
1688 勾选商品
→ 提交到本地工作台
→ 采集完整商品信息
→ 清洗标题 / 生成目标语言 Listing
→ 调用本地 Canvas 8123 的 TK工作流生成 5 张图
→ 图片和标题回到商品工作台可预览
→ 用户确认后编辑回同一条 canonical 妙手公共采集箱商品
```

对标产品可作为功能与前端 UI 参考，但不照搬店小秘/Temu 路径。本项目仍以 TK 工作台、妙手 API/skill、Canvas `TK工作流` 为边界。

## 2. 已对齐项

### 2.1 Canvas 本地工作流可用

本地 Docker 服务确认：

- `infinite-canvas` 容器运行中；
- 端口映射为 `127.0.0.1:8123 -> container:3000`；
- 本机监听 `127.0.0.1:8123`。

通过适配器读取 Canvas workflow capacity：

```json
{
  "workflowId": "workflow_2",
  "workflowVersion": 3063241676,
  "inputCapacity": 9,
  "expectedOutputCount": 5
}
```

结论：Canvas 8123 / `TK工作流` / 5 张图这个 Gate 1 关键能力可用。

### 2.2 当前已有一个商品完成到妙手编辑成功

`/api/v1/products` 返回当前商品状态：

```json
{
  "productId": "prod_mrrmrud3k9eftox2",
  "miaoshouSource": "success",
  "automation": "ready",
  "assetArchive": "ready",
  "listing": "ready",
  "canvas": "succeeded",
  "approval": "approved",
  "miaoshouEdit": "succeeded",
  "sourceImageCount": 77,
  "usableCanvasOutputCount": 5,
  "canonicalSuccessDetailId": "3814610360"
}
```

结论：代码和数据库层面存在完整成功链路样本。

### 2.3 妙手写入路径使用 canonical 公共采集箱商品

`ApprovalRepository.confirmAndEnqueue()` 会：

- 校验 `canonicalSuccessDetailId`；
- 创建不可变审批快照；
- 创建 `miaoshou_syncs`；
- 入队 `miaoshou_edit` job；
- payload 中保留 `canonicalSuccessDetailId`。

证据：

- `packages/db/src/repositories/approval-repository.ts:271-405`
- `apps/worker/src/handlers/miaoshou-edit.ts` 使用审批快照执行 `applyEdit`，并支持按 canonical detail 对账。

结论：核心后端路径符合“编辑同一条 canonical 妙手公共采集箱商品”的方向。

### 2.4 任务中心有基础恢复能力

任务中心已提供：

- 刷新；
- 暂停；
- 继续；
- 继续处理；
- 取消；
- 外部结果未知提示。

证据：

- `apps/web/src/app/tasks/page.tsx:27-55`
- `apps/web/src/components/tasks/task-recovery-actions.tsx:52-58`

结论：诊断和恢复基础存在，但还没有成为商品工作台的一部分。

## 3. 确认问题

### P1：商品表格仍暴露技术状态，不符合运营工作台要求

当前商品表格显示：

```text
采集:success · listing:ready · 编辑:succeeded
```

证据：

- `apps/web/src/components/products/product-table.tsx:31-39`
- `apps/web/src/components/products/product-table.tsx:73-77`
- `apps/web/src/components/products/product-table.tsx:121-124`

问题：运营用户看不出“当前是否可确认、是否已写回妙手、下一步做什么”。这与对标产品的“图片进度 / 问题提示 / 下一步 / 操作”不对齐。

修复方向：Gate 3 先定义业务状态机，再把表格列改成业务状态、图片进度、问题提示、下一步动作。

### P1：商品工作台缺少对标产品级别的主操作区和筛选工具条

当前 `ProductWorkbench` 主要由：

- StageOverview；
- ProductTable；
- ProductDrawer；
- footer 批量开始处理；
- 单商品进度。

证据：

- `apps/web/src/components/products/product-workbench.tsx:146-175`

缺失项：

- 目标店铺；
- 跑图张数；
- 自动生成开关；
- 确认后写回妙手开关/说明；
- 搜索；
- 来源筛选；
- 状态筛选；
- 问题筛选；
- 刷新/重置；
- 商品图片列；
- 图片进度列，例如 `主图 5/5`、`SKU 1/1`。

结论：当前工作台功能可操作，但产品信息架构不接近对标产品。

### P1：详情页不是完整商品处理/确认工作区

商品详情页只是摘要：

- 当前版本；
- 目标标题；
- Canvas 状态；
- 成图数量；
- 风险提示。

证据：

- `apps/web/src/app/products/[productId]/page.tsx:19-35`

Drawer 也只展示技术状态：

- `采集状态`
- `listing 状态`
- `妙手编辑状态`

证据：

- `apps/web/src/components/products/product-drawer.tsx:80-103`

问题：对标产品的详情/确认页是左侧图片确认、中间标题/属性/SKU、右侧检查结果和下一步。当前详情页无法承载运营复核。

修复方向：Gate 4 将详情页/审核页职责重新划分，商品详情应成为运营可检查的工作区，最终审核页承担确认写回。

### P1：设置页字段与 Worker 真实运行仍未打通

设置页展示 `Canvas 工作流` 字段：

- `apps/web/src/components/settings/sections/provider-options-section.tsx:20-23`

SettingsService 明确返回说明：

```text
这些值保存为工作区默认值；已启动的 Worker 进程不会被浏览器动态重配。
```

证据：

- `apps/web/src/server/services/settings-service.ts:94-102`

Worker 启动时直接 `loadConfig(env)`，并用 env 创建 adapter：

- `apps/worker/src/entry.ts:173-187`
- `packages/adapters/src/factory.ts:38-68`

当前实际状态：

- `.env`：`EXTERNAL_ADAPTER_MODE=live`
- DB `workspace_settings.external_adapter_mode`：`mock`
- DB `provider_options.canvasWorkflow`：`TK工作流`

结论：这是确认问题。UI 配置和 Worker 运行时配置存在双源状态，用户看到的设置不一定等于 Worker 实际行为。

修复方向：要么让 Worker 每轮读取 DB 工作区设置，要么 UI 明确标注哪些值需要重启/改 env；不能继续让用户以为设置页能动态控制 Worker。

### P1：当前运行数据有大量采集任务卡在 needs_input，但商品工作台没有把它们产品化呈现

数据库任务统计：

```json
[
  { "status": "needs_input", "kind": "miaoshou_collect", "count": 35 },
  { "status": "needs_input", "kind": "canvas_generate", "count": 2 }
]
```

问题：任务中心能看到技术任务，但商品工作台没有把“哪些商品采集失败 / 为什么失败 / 如何继续”合并到商品行里。对标产品的商品表格会直接展示“问题提示”和“下一步”。

修复方向：商品工作台需要合并任务异常摘要，至少在商品行展示最近阻断原因和可恢复动作。

### P2：商品列表页面和商品工作台职责重复且分裂

`/products` 页面文案要求用户回到 `/` 工作台开始处理：

- `apps/web/src/app/products/page.tsx:19-47`

问题：对运营来说“商品列表”和“商品工作台”是同一个主入口，不应分裂成两个概念。当前会造成导航困惑。

修复方向：Gate 4 决定是否合并，建议商品工作台作为主入口，商品列表降级为只读 catalog 或移除。

### P2：模板库具备基础字段，但还不是“按类目提示词 + 属性默认值”的完整基建

当前模板页支持：

- 名称；
- 类目规则；
- 参考素材 ID；
- 提示词片段；
- 目标语言；
- 视觉风格；
- 启用。

证据：

- `apps/web/src/components/templates/template-manager.tsx`

缺失：

- 类目属性默认值；
- 标题提示词模板与图片提示词模板的分区；
- 生图比例/跑图数量的产品化配置；
- 与 Canvas `TK工作流` 的可视化绑定。

结论：模板库有基础，但未达到对标产品“前期基建”层。

### P2：开发态冷编译会造成“没反应”的用户感知

Next 日志显示首次请求耗时：

- `/` 首次约 11s；
- `/api/v1/settings` 首次约 6.7s；
- `/products/[productId]` 曾出现 26.5s 编译耗时。

后续请求恢复到几十到几百毫秒。

结论：这不是 DB 锁，也不是业务链路阻断；是开发态冷编译/首次加载体验问题。但用户会感知为“点击没动静”。本地生产模式或预热可以缓解。

## 4. 非问题 / 已排除项

### N1：Canvas 本地 8123 未监听 —— 已排除

端口和 Docker 均确认正常：

- `127.0.0.1:8123` 监听；
- `infinite-canvas` up；
- workflow capacity 可读。

### N2：妙手写入一定是重复创建商品 —— 当前证据不支持

后端审批和编辑路径使用 `canonicalSuccessDetailId`，并把它写入审批快照和 `miaoshou_edit` job payload。当前证据指向“编辑 canonical 商品”，不是直接创建重复商品。

### N3：3000 完全不可用 —— 已排除

首次 curl 曾因冷编译超时，但 Next 日志显示后续页面和 API 都能返回 200。运行时不是完全不可用。

## 5. Gate 2 总结

当前实现具备真实链路骨架：

- 1688/妙手采集；
- 本地商品池；
- 资产归档；
- Listing；
- Canvas 5 图；
- 审批；
- 妙手编辑。

但当前产品体验仍不达标：

- 商品工作台不是运营主控台；
- 状态语言过于工程化；
- 图片进度、问题提示、下一步动作缺失；
- 设置页和 Worker 运行时双源；
- 详情页不能承载轻量复核；
- 任务异常没有回流到商品行。

## 6. 下一步

进入 Gate 3：定义业务状态机。

Gate 3 必须先解决：

1. 技术轴状态到业务状态的映射；
2. 每个业务状态的主动作；
3. 每个失败状态的用户可读原因；
4. 商品行、详情页、任务中心之间的状态职责边界。

Gate 3 完成后再进入 Gate 4：按对标产品重设计商品工作台信息架构。

