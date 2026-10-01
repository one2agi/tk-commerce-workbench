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
* **前端体验重构（KISS & YAGNI + Taste Soft）**：已于 2026-09-29 完成落地，详见 [docs/product/frontend-ux-audit-kiss-yagni.md](file:///mnt/d/project/TKcaiji/tk-commerce-workbench/docs/product/frontend-ux-audit-kiss-yagni.md)
  - [x] **详情页图片模块四合一精简**：砍掉中间多轮重复渲染卡片，收敛为主图画廊与排序器，去除多轮确认阻断；
  - [x] **表格行动点合二为一**：合并【下一步】与【操作】为唯一的【主行动点】，释放 180px 表格横向空间；
  - [x] **底层研发调试黑话脱敏**：主界面隐藏 `rev_xxx`、`deterministic` 等开发调试词汇，收敛至折叠式技术排障抽屉；
  - [x] **底部操作栏改为按需浮动**：未勾选商品时 100% 释放视口高度，勾选后以 Taste Soft 浮动操作岛（Floating Pill）平滑滑入；
  - [x] **图片加载容错与优雅降级**：统一采用带 SVG Placeholder 的优雅缩略图，杜绝原生浏览器裂图破损。
* **工作台总览界面极简重构（库库上架-妙手版基线）**：已于 2026-09-29 完成落地，彻底告别暗黑杂乱风格
  - [x] **纯净浅色侧边栏**：左侧统一为白底灰边框与精致 SVG 矢量图标，保持高净空，不堆砌多余底层运行状态；
  - [x] **紧凑型状态切换 Tab**：废除大矩形粗框卡片，收敛为轻量下划线指示 Tab，右侧常驻醒目实心绿色 `[ 🍵 写入妙手未发布 ]` 与 `[ 🔄 补图 / 批量处理 ]` 按钮；
  - [x] **5 列高密度极简表格**：彻底砍掉多余冗余列，消除横向滚动条，行高收敛至 ~72px。首列整合复选框、48x48 缩略图、商品标题、1688 货源徽标、货源单价与抓取时间；
  - [x] **动态生图进度与彩色状态药丸**：图片列直接渲染彩色流光进度条，状态列采用语义化状态药丸（等写入、生图中、已完成、失败）；
  - [x] **底部分页与汇总栏**：常驻底部待处理汇总与简洁页码控制器。
* **商品质检与放行台极简主义重构（Curated Gallery & Inspection Desk）**：已于 2026-09-29 完成落地
  - [x] **业务角色定位明确**：从“控制台”转变为“AI 交付物最终质检与放行台”。90% 场景为质检 5 张 AI 最终成图并快速放行；
  - [x] **大留白居中展台**：容器限制 `max-w-[1060px]` 居中布局，搭配温润 `#fafaf9` 画布与 24px 大圆角卡片，彻底消灭拥挤压迫感；
  - [x] **Hero 大图 + 5张主图胶囊**：上方居中沉浸式 Hero 展台，下方精致胶囊缩略条点击无缝切换大图并自带放大查看；
  - [x] **渐进式披露收纳冗余**：1688 原厂 24 张底图收纳至 `<details>` 折叠抽屉；已生成的详细 Slot 列表与拖拽调优同样收纳入 `<details>`，仅在有未就绪项时展开，不打扰核心质检；
  - [x] **常驻胶囊型悬浮放行岛**：视口底部浮动操作岛，左侧微光呼吸绿点提供状态 Reassurance，右侧提供醒目的翡翠绿 `[ 确认放行 · 写入妙手 ]` 按钮；
  - [x] **纯净矢量图标体系**：全界面杜绝系统默认 emoji 图标，采用统一的纯 SVG 线性矢量图标库（`review-icons.tsx`）。
* **对标产品（海淘上架助手 / 库库上架）系统与前端设计规范**：
  - 系统架构与演进路线：详见 [docs/product/benchmark-haitao-assistant-design.md](file:///mnt/d/project/TKcaiji/tk-commerce-workbench/docs/product/benchmark-haitao-assistant-design.md) (2026-10-01)
  - 前端 UI/UX 深度设计规范：详见 [docs/product/benchmark-haitao-assistant-ui-design.md](file:///mnt/d/project/TKcaiji/tk-commerce-workbench/docs/product/benchmark-haitao-assistant-ui-design.md) (2026-10-01)
  - 写入记录与生成流水极简落地（Taste Soft 范式）：
    - 5 格 Bento 指标栏（今日采集、今日写入、今日成功、今日失败、今日生图）采用双层外圈（Double-Bezel）同心圆角设计；
    - 双 Tab 架构（`写入记录` vs `生成记录`），支持搜索过滤、状态筛选与妙手 ERP 直跳链接；
    - Button-in-Button CTA 重写按钮，仅针对失败或未成功项允许重试，并防御性阻断成功项避免妙手重复建单；
  - 核心借鉴：类目模版与必填属性预设（根治 ISSUE-01）、上架自动化抽屉（自动生图/自动写回/定时夜间批处理）、本地多文件夹拖拽选品导入、SKU 白底抠图与标题标准化。
* **避坑要点：测试断言对 DOM 文本与 Role 的硬约束**：
  - 核心操作按钮内部若被测试以 `/<button[^>]*>(.*?)<\/button>/` 正则匹配，不能在主按钮内嵌套 `<svg>` 或额外标签，需保持文本纯净；
  - 同一页面若同时存在静态操作面板和浮动操作岛，二者按钮文案与状态文案需做语义区分（例如主按钮“确认并写回妙手”，浮动按钮“确认放行 · 写入妙手”），避免 TestingLibrary `getByRole("button")` 出现重复冲突；
  - **CSS 架构铁律**：前端未挂载 Tailwind 构建编译器，所有新增样式必须在 `apps/web/src/app/globals.css` 维护语义化 `.tk-*` 类名；
  - **Vitest 环境隔离**：JSDOM 测试需在 `vitest.jsdom.config.ts` 注册，严禁在文件头加 `/** @vitest-environment jsdom */` 导致 vmThreads 死锁超时；
  - **SSR Hydration 一致性**：时间日期显示使用确定性 ISO 字符串切片，杜绝客户端本地时区与服务端 UTC 不一致引发的水合报错。
* **导航高响应度与页面切换性能基线 (2026-10-01)**：
  - **根本成因**：Next.js App Router 页面切换运行在 `startTransition` 中，目标页面 SSR 期间旧页面保持完全冻结且 `pathname` 不变；若无即时视觉反馈，用户会产生 400~800ms 的“死机假象”并导致重复连击；
  - **核心方案**：
    1. `<Sidebar>` 引入客户端即时 Pending 激活态（点击 30ms 内触发 `.is-pending` 柔和高亮）；
    2. 根布局挂载全局 2.5px 极简流光进度条 `<NavigationProgressBar />`（跨页面无感流转）；
    3. 注入根级 `apps/web/src/app/loading.tsx` 骨架屏（杜绝旧页面冻结）；
    4. 纯静态页面 `/processing-rules` 剔除 `force-dynamic`，启用客户端瞬时缓存。


