# 项目核心记忆库 (Project Memory)

> **创建时间**：2026-09-29  
> **维护规范**：跨会话核心上下文沉淀文档。任何核心链路变更、架构决策或生产环境调整，均需同步更新本文档。

---

## 目录
1. [项目定位与业务价值](#1-项目定位与业务价值)
2. [系统架构与模块拓扑](#2-系统架构与模块拓扑)
3. [端到端全链路实测基线](#3-端到端全链路实测基线)
4. [核心约束与避坑法则（踩坑记忆）](#4-核心约束与避坑法则踩坑记忆)
5. [待解决问题与演进清单 (Backlog)](#5-待解决问题与演进清单-backlog)

---

## 1. 项目定位与业务价值

* **产品名称**：TK Commerce Workbench（TikTok 商品自动化工作台）
* **核心业务主链路**：
  $$\text{1688 源头货源采集} \longrightarrow \text{跨境 Listing 翻译与属性规整} \longrightarrow \text{AI 营销主图智能清洗} \longrightarrow \text{妙手 ERP 草稿箱写回}$$
* **当前服务运行状态**：
  - **前端 Web 工作台**：`http://127.0.0.1:3005/`（Docker 容器运行，启用 Next.js HMR 热重载）
  - **后台 Worker 服务**：实时监听 PostgreSQL 任务队列（`tsx watch` 自动热重启）
  - **数据库**：PostgreSQL 16（端口 `127.0.0.1:5432`，库名 `tk_workbench`）

---

## 2. 系统架构与模块拓扑

### 目录与分层结构 (pnpm Monorepo)

* `apps/`
  - `web/`：Next.js 16 App Router（React 19）工作台。主要页面：`/`（商品总览）、`/products/[productId]`（商品审核详情）、`/write-records`（写回日志）、`/templates`（生图模板）、`/settings`（系统配置）。
  - `worker/`：后台异步任务处理器。处理任务类型：`listing_generate`、`canvas_generate`、`miaoshou_writeback` 等。
  - `extension/`：Chrome MV3 扩展，用于 1688 商品详情页的原生一键提取与本地上报。
* `packages/`
  - `contracts/`：领域类型、状态机定义、Zod Schema 与端口定义（前后端单一真理源）。
  - `domain/`：纯业务逻辑（定价公式、选品质量分、属性清洗、模板匹配）。
  - `db/`：Drizzle ORM 数据持久层、本地内容寻址存储（CAS，位于 `/app/data/assets`）。
  - `adapters/`：外部平台对接实现（妙手 ERP OpenAPI、SiliconFlow/通义 MAI 生图大模型、汇率服务）。
* `docs/`
  - `product/`：产品规格、待办清单、UX 走查报告。
  - `superpowers/`：历史重构计划（plans）、技术规范（specs）与复盘报告（reports）。

---

## 3. 端到端全链路实测基线

在 2026-09-28 已完成真实三方 API 的全链路贯通验证：

* **实测商品标的**：1688 民族风编织草帽
  - 本地商品 ID：`prod_ms1ddwgom8del6e8`
  - 1688 Offer ID：`1016094589470`
  - 1688 原厂链接：`https://detail.1688.com/offer/1016094589470.html`
* **AI 洗图产物**：
  - 调用模型：`Qwen/Qwen3-VL-8B-Instruct` 规划提示词 + `Tongyi-MAI/Z-Image-Turbo` 生成；
  - 产出 5 张高质量电商营销主图，本地 CAS 归档与云端签名直链已双向绑定。
* **妙手 ERP 写入凭据**：
  - 妙手草稿箱 Detail ID：`3836315996`
  - 写入状态：`succeeded`
  - 实际同步内容：5 张新主图、泰文本地化标题与描述（`เหมาะกับการใส่ในชีวิตประจำวัน`）、规格属性映射及纠偏后的重量与库存。
  - 对应写回记录 ID：`sync_muld83pcn63ww4v8`。

---

## 4. 核心约束与避坑法则（踩坑记忆）

1. **端口漂移防范**：
   - 宿主机配置 `.env` 必须声明 `TK_WEB_PORT=3005`，Docker Compose 会自动将容器内 3000 端口映射到宿主机 `3005`。切勿漏配导致端口回退至 3000。
2. **妙手 ERP 刊登校验安全垫 (Crucial)**：
   - **重量下限**：妙手 API 强制要求 `weight >= 0.01 kg`（1688 原厂常乱填 `0.001 kg`，直接提交会被拒）。
   - **库存上限**：妙手 API 限制 `stock < 100,000`（1688 原厂常填几百万，提交会被拒）。
   - **防腐规则**：所有数据向妙手提交前，必须经由 `packages/adapters/src/miaoshou/edit-adapter.ts` 的规格修正垫进行 Clamping 过滤。
3. **生图服务 Content-Type 陷阱**：
   - SiliconFlow 等临时 S3 URL 返回的响应头往往是 `application/octet-stream`。
   - `packages/db/src/assets/content-addressed-store.ts` 必须支持结合 URL 后缀（`.png` / `.jpg`）和内容二进制特征码进行嗅探，不能仅依靠 HTTP Content-Type。
4. **工作台状态投影一致性**：
   - 前端工作台统计“主图 5/5”依赖 `canvas_runs` 记录中的 `outputs` 字段（包含生成的 Asset ID 列表）。每次生图完成后必须原子写入 `canvas_runs` 并更新 `products.state_canvas = 'succeeded'`。

---

## 5. 待解决问题与演进清单 (Backlog)

* **链路风险清单**：详见 [docs/product/pending-issues.md](file:///mnt/d/project/TKcaiji/tk-commerce-workbench/docs/product/pending-issues.md)
  - ISSUE-01：源头 1688 数据脏乱导致 ERP 刊登校验阻断（类目规则智能估重）
  - ISSUE-02：AI 生图 24h 临时外链过期风险（商户永久 OSS/S3 图床对接）
  - ISSUE-03：AI 生图模型主体保真度不足与幻觉（增加手动基准底图勾选）
  - ISSUE-04：跨境多语言本地化中的国内内贸属性残留（黑白名单过滤词）
* **前端体验重构（KISS & YAGNI）**：详见 [docs/product/frontend-ux-audit-kiss-yagni.md](file:///mnt/d/project/TKcaiji/tk-commerce-workbench/docs/product/frontend-ux-audit-kiss-yagni.md)
  - 详情页图片模块四合一精简，去除多轮确认；
  - 表格【下一步】与【操作】合并为单一清晰的 Primary Action；
  - 研发调试技术黑话（`rev_xxx`, `deterministic`）界面脱敏；
  - 底部全灰批量操作栏改为按需浮动呼出；
  - 增加图片加载失败的优雅占位符（Fallback Placeholder）。
