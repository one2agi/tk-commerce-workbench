# TK Commerce Workbench Greenfield Design

**Status:** Approved by product review on 2026-07-15

## 1. Goal

从零建设一个本地单用户的 TikTok Shop 商品处理工作台。浏览器扩展在 1688 店铺预览中收集用户勾选的商品链接，本地平台调用妙手 ERP `fetch_item` 作为主采集器并把公共采集箱详情导入商品池；用户点击“开始处理”后，系统自动下载素材、结构化商品与 SKU、生成目标语言 Listing、自动定价、选择图片并运行 Canvas `TK工作流`；最后在编辑同一条妙手公共采集箱商品前再要求一次人工确认。

MVP 的终点是妙手 ERP 公共采集箱。系统不自动认领到 TikTok 采集箱，不自动发布到 TikTok Shop，也不接入 Shopee、Ozon 等其他平台。

## 2. Greenfield Boundary

项目目录与仓库名称为 `tk-commerce-workbench`。

`one-click-publish`、`tk-autopilot` 和 `TKskill` 只用于理解现有业务、解析思路和外部 API，不复制其认证、数据库、发布链路或运行时结构。新项目必须拥有独立的依赖、数据库迁移、测试基线、配置和版本历史。

MVP 为本地单用户，不提供注册、登录、角色或多租户。应用启动时确保数据库中存在一个固定本地操作员。浏览器扩展使用独立 Bearer Token 调用本机摄取 API。

## 3. Product Scope

### 3.1 Target Channel

- 首发平台：TikTok Shop。
- 首发站点：泰国。
- 默认 locale：`th-TH`。
- 默认币种：`THB`。
- 默认重量单位：`kg`。
- 默认尺寸单位：`cm`。

语言不可写死。工作区可设置默认目标语言和翻译风格，单个商品可覆盖默认值。品牌、型号和专有词可按规则保留英文；1688 中文原文必须始终保留。

### 3.2 Human Decision Boundary

正常成功路径有两个明确的人工动作：

1. 商品进入商品池后，用户点击“开始处理”或对勾选商品点击“批量开始处理”；
2. 最终预览生成后，用户点击“确认并推送妙手”。

“开始处理”是模型调用和 Canvas 生图费用的控制边界。用户在扩展点击采集时，系统只允许调用妙手货源采集与只读详情查询，把商品修订显示在商品池；不得自动调用 LLM、汇率、Canvas，也不得编辑、认领或发布妙手商品。点击开始后，中间步骤全部自动运行，不再逐步确认。

点击“开始处理”后，以下步骤默认自动执行：

1. 下载并归档原始素材；
2. 标准化商品、SKU、属性和单位；
3. 清洗标题并生成目标语言 Listing；
4. 自动计算目标站点售价；
5. 匹配生图模板和参考图；
6. 自动过滤并排序 Canvas 输入图；
7. 预检并运行 Canvas `TK工作流`；
8. 下载并归档 Canvas 输出；
9. 生成最终待确认预览。

验证码、1688 登录失效、缺少关键成本、外部密钥缺失或不可恢复错误会暂停相应任务并要求用户处理，不得用猜测数据继续推送。

## 4. Architecture

采用 pnpm workspace 管理的模块化 TypeScript Monorepo，不引入 Turborepo 或微服务编排器。

```text
apps/web          Next.js 本地操作台与 HTTP API
apps/worker       可恢复的后台任务执行器
apps/extension    Manifest V3 1688 店铺预览与链接选择扩展
packages/contracts 版本化链接摄取、妙手详情与内部 API 合同
packages/domain     商品、状态、定价、审批等纯领域逻辑
packages/db         Drizzle schema、迁移和 repositories
packages/adapters   妙手采集/编辑、Canvas、LLM、汇率和临时图片中转适配器
packages/config     环境变量解析、默认值和脱敏配置视图
```

运行依赖：

- Node.js 22 LTS；
- pnpm 9；
- Next.js App Router；
- PostgreSQL 16；
- Drizzle ORM 与显式版本迁移；
- Vitest；
- Playwright；
- Docker Compose 仅负责本地 PostgreSQL 和测试依赖。

Web 与 Worker 是不同进程，但共享领域、数据库和适配器包。网页请求只创建或查询任务，绝不在 HTTP 生命周期中执行长时间的批量下载、生图轮询或妙手同步。

## 5. End-to-End Flow

```text
1688 店铺页
  -> 扩展扫描商品卡片并生成预览
  -> 用户勾选商品
  -> 扩展把规范化商品链接发送到本机 API
  -> 本地平台调用妙手 fetch_item
  -> 按 sourceItemId 定位成功的公共采集箱详情
  -> 查询并导入妙手标准化详情
  -> PostgreSQL 商品修订 + 商品池（待处理）
  -> 用户点击开始处理或批量开始处理
  -> PostgreSQL 创建幂等自动化运行与持久任务
  -> Worker 下载素材到本地
  -> Listing/价格/模板/选图自动处理
  -> Canvas 临时上传 + TK工作流
  -> Canvas 输出下载到本地
  -> 最终预览
  -> 用户确认一次
  -> 编辑同一条妙手公共采集箱商品
```

扩展每个商品使用稳定的幂等键。摄取 API 对相同幂等键返回同一结果；同一来源商品的新采集批次在妙手查询最新成功详情后创建新修订，不覆盖历史修订。相同商品修订的重复“开始处理”请求返回同一个自动化运行，不重复创建 LLM、Canvas 或其他下游任务。

## 6. 1688 Collection

### 6.1 Store Preview

扩展在 1688 店铺商品列表页扫描当前可见和按用户操作加载出的商品卡片，生成包含商品 ID、标题摘要、价格摘要、缩略图和来源链接的预览列表。只有用户勾选的商品链接发送到本地平台；MVP 不提供无确认的全店采集。

### 6.2 Miaoshou Source Collection

本地平台通过 `miaoshou-erp-source-import` 的合同调用：

- `POST /open/v1/product/common_collect_box/common_collect_box/fetch_item`；
- 请求字段 `collectLinks`；
- 响应映射 `sourceItemIdAndDetailIdMap`。

`fetch_item` 返回的 detail ID 不保证对应可查询的成功详情。重复来源商品可能返回状态为 `skip` 的新记录，并给出“产品已经采集过”；该 skip 记录的详情查询可能返回“数据链接为空”。适配器必须按 `sourceItemId` 查询公共采集箱列表，选择已有或最新的 `success` 记录作为 canonical Miaoshou detail ID，再调用 `get_common_collect_box_detail`。

成功详情至少导入标题、货号、描述、类目、价格、库存、重量、主图、详情 HTML 图片、来源属性、销售属性、颜色/尺寸映射、SKU map 和来源链接。空字段必须原样记录为缺失，不得由采集适配器猜测。

扩展只负责商品卡片预览、勾选、链接规范化和提交，不负责解析 1688 详情页。单个妙手采集失败不终止批次；成功、重复复用、失败分别记录。

## 7. Product Graph and Revisions

“商品图谱”使用 PostgreSQL 的结构化关系模型，不使用图数据库。

主要聚合：

- `source_shops`：1688 店铺身份；
- `products`：稳定的来源商品身份；
- `product_revisions`：每次采集形成的只读原始快照；
- `miaoshou_source_records`：source item ID、fetch 返回 ID、canonical success detail ID、状态、失败原因和采集时间；
- `skus` 与 `sku_dimensions`：规格维度、组合、成本和库存；
- `assets`：本地素材、角色、来源、哈希与可用状态；
- `listing_drafts`：按站点与语言生成的可编辑工作副本；
- `pricing_runs`：输入、汇率、费用、公式版本和输出；
- `canvas_runs`：输入顺序、实时合同、远端任务和输出；
- `approval_snapshots`：最终不可变确认快照；
- `miaoshou_syncs`：写入、对账和远端商品映射；
- `jobs` 与 `worker_instances`：可恢复任务及 Worker 心跳；
- `audit_events`：脱敏操作记录。

原始修订永远只读。修改 Listing、图片选择、模板、语言或定价会递增工作副本版本并使已有审批失效。妙手适配器只能读取有效的不可变审批快照。

## 8. State Model

状态必须分轴保存：

- collection：`queued | submitting | resolving_duplicate | importing | partial | complete | failed`；
- Miaoshou source：`not_started | submitted | pending | success | skipped_duplicate | failed`；
- automation：`not_started | queued | running | paused | needs_input | ready | failed | cancelled`；
- asset archive：`pending | downloading | ready | partial | failed`；
- listing：`pending | generating | needs_input | ready | failed`；
- canvas：`not_started | queued | running | partial | succeeded | failed`；
- approval：`unapproved | approved | invalidated`；
- Miaoshou edit：`not_started | queued | syncing | result_unknown | succeeded | failed`。

UI 可以组合展示一个用户友好阶段，但业务逻辑不得依赖单一总状态。

## 9. Local Asset Storage

本地文件系统是图片的永久事实来源。默认内容寻址路径：

```text
data/assets/<sha256[0:2]>/<sha256>.<normalized-extension>
```

每个素材保存 SHA-256、MIME、字节数、像素尺寸、本地相对路径、妙手返回 URL、原始来源 URL（如可得）、来源类型、业务角色、排序和生成溯源。相同内容只保存一份文件，多个业务记录可以引用同一内容。

调用 Canvas 时，`AssetStagingAdapter` 通过 Canvas 已有 multipart 或 Base64 上传接口把本地文件临时上传，并返回本次任务可用的外部 URL 或远端文件标识。Canvas 输出完成后立即下载到本地并校验。

妙手的图片字段要求 URL。同步前适配器为已批准的本地图片创建临时可访问 URL，执行可达性检查，随后立即提交。URL 失效时自动重新上传。S3、OSS 或 R2 是可选的未来 staging/storage adapter，不是 MVP 运行依赖。

## 10. Listing Generation

标题清洗和翻译使用可配置的 OpenAI-compatible provider：base URL、API key、model 和超时由本地设置管理。实现不得绑定单一厂商。

确定性规则在模型调用前后执行：

- 清除重复词、批发话术、联系方式和不可见字符；
- 保留品牌、型号和配置的 allowlist；
- 禁止生成原始证据中不存在的材质、认证、功效或参数；
- 按目标站点的长度和禁词规则验证；
- 模型失败时降级为规则清洗，并明确标记降级结果。

每次生成保存 provider、model、prompt 版本、输入摘要和结构化输出，不保存明文 API key。

## 11. Automated Pricing

基础公式：

```text
target_price = round_rule(
  ((source_cost_cny + domestic_shipping_cny + cross_border_cost_cny)
    * cny_to_target_rate
    + fixed_target_cost)
  / (1 - platform_fee_rate - payment_fee_rate - target_profit_rate)
)
```

工作区可配置成本项、平台佣金、支付手续费、利润率、最低利润、最低售价和尾数规则。单个商品可覆盖参数。

汇率每天自动获取一次，成功值带来源和时间戳缓存。远端获取失败时使用最近一次成功值并显示过期提示；用户可手动覆盖。缺少重量、关键成本或有效汇率时，Listing 进入 `needs_input`，不得自动推送妙手。

价格、重量和尺寸在数据库中使用明确单位；妙手 mapper 负责一次性转换，不允许在 UI、领域层和适配器中重复换算。

## 12. Template Library and Automatic Image Selection

模板库保存：名称、适用品类规则、参考图、提示词片段、目标语言、图片风格、启用状态和版本。

系统按品类规则选择最高优先级模板；无法唯一匹配时使用工作区默认模板。参考图属于模板素材，可自动加入 Canvas 输入。

自动选图依次考虑：

1. 商品主图；
2. 不同角度商品图；
3. 材质、结构和功能细节；
4. 差异明显的 SKU 图；
5. 模板参考图。

选择器使用像素尺寸、可下载性、感知哈希、清晰度、重复度和可配置视觉评分过滤低清、重复、水印、拼接和非商品图。

每次运行前 `CanvasAdapter` 必须读取实时工作流元信息。当前目标为 Canvas `TK` 画布、`TK工作流` 子工作流；实时输入容量可变，当前观察值九个槽位不是固定合同。至少选择一张商品图，不超过实时容量，未用槽位保持空白，禁止用重复图补齐。

正常期望五张生成图。少于五张但至少一张有效图记为 partial，并保留全部有效结果；零张有效图记为 failed。失败重试不得删除历史成功输出。

## 13. Durable Automation

任务队列基于 PostgreSQL 租约，不引入 Redis。每个 job 保存：类型、业务键、幂等键、payload snapshot、状态、attempt、最大尝试次数、next attempt、lease owner、lease expiry、last heartbeat、远端 task ID、错误分类和结果摘要。

Worker 使用 `FOR UPDATE SKIP LOCKED` 认领任务，定期续租；进程重启后可回收过期租约。重试采用带抖动的指数退避。

妙手货源采集、Canvas 生成和妙手编辑具有费用或外部副作用：

- 已存在成功妙手详情或成功幂等结果时直接复用；
- 网络超时导致结果未知时进入 `result_unknown`；
- `result_unknown` 必须先用远端任务 ID、来源商品 ID、item number 或审计键对账；
- 未完成对账前不得直接再次创建。

应用提供全局暂停、单批次暂停/继续、单任务取消和失败任务重跑。处于 `not_started` 的商品只保存采集结果，不会被 Worker 自动认领。开始处理 API 必须在一个事务中创建或复用 automation run 及其首批 jobs。

## 14. Approval and Miaoshou

最终确认页展示：目标站点、语言、标题、描述摘要、售价计算明细、SKU 数、库存、重量、尺寸、最终图片、警告和妙手目标。

点击“确认并推送妙手”时，服务端先在事务中创建不可变审批快照，再排队 Miaoshou edit job。快照至少包含：

- source platform、source product ID、canonical URL；
- locale、currency 和 channel；
- title、description、attributes；
- item number；
- price、stock、weight、dimensions 及明确单位；
- SKU 属性、价格、库存和图片关系；
- 有序最终素材 ID；
- product revision、listing version、pricing run 和 template version。

Miaoshou MVP 的正常链路执行两类操作：开始时用 `fetch_item` 采集来源商品，结束时编辑同一条 canonical 公共采集箱详情。系统不为正常链路重复创建第二条公共采集箱商品，不调用认领接口，不调用 TikTok 采集箱编辑接口，也不调用发布接口。

公共采集箱编辑后并不等于 TikTok 发布就绪。平台认领后的类目叶子节点、平台必填属性、仓库、制造商、认证、责任人等字段只能在未来的平台阶段按真实元数据补齐；本地系统不得 AI 猜测这些合规字段。

## 15. User Interface

### 15.1 Overall Layout

桌面端主界面采用已经过产品确认的融合式工作台，不在“表格模式”和“看板模式”之间要求用户来回切换：

- 左侧固定导航承载商品工作台、采集任务、处理任务、图片模板、标题规则和系统设置；
- 顶部阶段总览以看板卡片展示全部、待处理、处理中、待确认、需处理和已同步妙手的商品数量；
- 点击阶段卡片直接筛选下方商品表格，阶段看板只负责全局状态感知和筛选，不承担拖拽改状态；
- 中部高密度表格负责勾选、批量开始、批量重跑、查看进度和进入确认等高频操作；
- 右侧详情抽屉展示当前选中商品的原始资料、处理设置、价格预览、Canvas 输出、缺失字段警告和当前可执行动作；
- 用户关闭详情抽屉时表格仍保持筛选、勾选和滚动位置，批量操作不会因查看单品而丢失上下文。

桌面端优先保证批量效率。MVP 不设计可拖拽 Kanban，也不把一个商品的业务状态直接交给用户拖动修改，避免 UI 展示状态与后台真实任务状态不一致。

### 15.2 Product Pool

展示来源、店铺、中文标题、目标标题、站点、价格、图片数量、自动化阶段、警告和最终确认状态。支持单商品“开始处理”、勾选商品“批量开始处理”、筛选以及批量重跑非写入步骤。

表格中的“自动化进度”用采集、Listing、Canvas、确认/同步等小型进度节点表达，但该进度只由分轴业务状态聚合计算，不能成为新的持久化总状态。阶段总览中的数量也必须由同一套状态投影生成。

商品进入 `not_started` 后显示为“待处理”；用户勾选多个待处理商品时，顶部主要操作显示“批量开始处理（N）”。处理中商品提供查看进度，待确认商品提供“去确认”，异常商品提供与错误类型匹配的补充资料或重试入口。

### 15.3 Product Workspace

对照原始中文数据与目标 Listing；展示 SKU、定价明细、原图、自动选图原因、模板参考图、Canvas 输出和最终图片顺序。允许修改工作副本、切换语言或模板并重新运行后续步骤。

右侧详情抽屉用于快速查看和轻量调整；涉及完整 SKU 编辑、图片排序、标题与描述对照、定价明细或最终确认时，进入完整商品工作区。抽屉和完整页面操作同一个版本化工作副本，不得产生两套数据。

### 15.4 Task Center

展示店铺采集、素材、Listing、Canvas 和妙手任务，包含尝试次数、下次重试、暂停原因和恢复操作。

### 15.5 Template Library

管理品类规则、参考图、提示词、语言、风格、版本和默认模板。

### 15.6 Settings

管理扩展 Token、语言、翻译 provider、定价、汇率、Canvas、妙手、本地素材目录、并发、速率和重试策略。密钥只显示是否已配置，不回显明文。

## 16. Error Handling

- 妙手采集返回 `skip/产品已经采集过`：按 source item ID 查询并复用 success 详情，不把 skip ID 当作 canonical detail ID。
- 妙手详情暂不可查询：有限轮询并展示 pending；不得再次提交同一来源链接。
- 采集缺少来源 ID 或任何可用商品图：invalid，不进入自动生图。
- 采集缺少标题、价格、SKU 或部分属性：partial，进入处理但在 UI 保留明确 warning code。
- 素材下载失败：保留来源 URL 和失败原因；至少一张可用商品图时允许继续。
- LLM 不可用：规则降级或 `needs_input`，不得伪造事实。
- Canvas 合同变化：预检失败并暂停，不发送不兼容请求。
- Canvas 部分输出：保存有效输出，标记 partial，可人工重跑。
- 妙手校验失败：展示字段级错误并回到工作副本；审批快照保留用于审计。
- 妙手编辑结果未知：先按 canonical detail ID 对账，不盲目重试编辑。

## 17. Security

- API key、妙手 AppSecret 和扩展 Token 仅存环境变量或本地加密 secrets 文件；数据库只保存引用和配置状态。
- 开发环境统一使用标准 `MIAOSHOU_APP_KEY` / `MIAOSHOU_APP_SECRET` 环境变量；不得依赖仓库内可提交、全局可读写的明文 `env.txt`。
- 扩展 Token 保存为 SHA-256 digest，比较使用常量时间算法。
- 本地 API 默认仅监听 loopback；如用户显式开放局域网，必须配置允许来源。
- 服务端下载外部 URL 时仅允许 `http/https`，跟随有限次重定向，并阻止 loopback、private、link-local 和云元数据地址，防止 SSRF。
- 日志和审计必须脱敏 headers、tokens、signed body 和 credentials。
- Canvas 自动生图提供每日运行上限和全局暂停开关，避免异常循环产生费用。

## 18. Testing and Acceptance

### Validated Miaoshou Contract

2026-07-15 的真实只读验证确认：重复提交一个已采集的 1688 商品时，`fetch_item` 返回新的 skip detail ID 和“产品已经采集过”，而已有 success detail 仍可按 source item ID 查询。成功详情样本包含标题、九张商品图、五张详情 HTML 图片、四十三项来源属性、二十八个 SKU、四个颜色、七个尺码、SKU 价格/库存和重量；包装尺寸、SKU 独立货号、尺码表、主图视频、认证和供应商详情为空。测试 fixtures 必须覆盖这一实际行为，不得假设 fetch 返回 ID 永远可直接查询。

### Test Layers

- Domain tests：URL 规范化、幂等、修订、状态、价格、单位、选图、审批失效。
- Adapter contract tests：妙手首次采集、重复 skip 解析、成功详情导入、Canvas、LLM、汇率和临时图片 staging 固定 fixtures。
- Integration tests：真实 PostgreSQL、迁移、repository、租约、恢复和本地素材。
- Extension tests：店铺预览解析、勾选、URL 规范化、重复过滤、批量提交和暂停恢复。
- Playwright E2E：从模拟扩展提交链接、Mock 妙手采集/详情导入，到最终 Mock 妙手编辑收到唯一审批商品。

### MVP Acceptance

1. 全新机器按文档可启动 Web、Worker、PostgreSQL 和扩展开发包；
2. 1688 店铺预览中只有勾选链接被提交到妙手采集；
3. 妙手首次 success 与重复 skip 都能解析到同一 canonical 公共采集箱详情；
4. 同一摄取请求不会创建重复本地商品或重复下游任务；
5. 新采集商品停留在 `not_started`，未点击开始处理前不会调用 LLM、汇率或 Canvas；
6. 单个开始和批量开始都会为每个商品创建唯一的幂等自动化运行，重复点击不会重复生图；
7. 原始中文数据和下载到本地的素材不会被重跑覆盖；
8. 自动生成可配置语言 Listing，并保存模型或规则降级证据；
9. 泰国站价格使用可审计公式与汇率，缺少关键输入时不会推送；
10. Canvas 读取实时容量，不重复补图，输出立即下载到本地；
11. Worker 中断后恢复，不重复产生 Canvas 或妙手外部副作用；
12. 修改工作副本会使旧审批失效；
13. 最终确认只编辑 canonical 公共采集箱详情，不创建第二份商品；
14. UI 和 API 不存在自动认领、TikTok 采集箱编辑或自动发布路径；
15. 全仓测试、类型检查、lint 和构建从初始提交起保持通过。
16. 商品工作台同时提供可点击的阶段总览、高密度表格和单品详情抽屉；阶段筛选、表格勾选和抽屉开关不会互相清空用户上下文；
17. UI 阶段数量、表格状态和自动化进度均从分轴状态投影产生，用户不能通过拖拽直接伪造后台任务状态。

## 19. Non-Goals

- 多用户、注册登录、角色权限和云端 SaaS；
- 无选择的全店自动采集；
- 在扩展中维护完整的 1688 详情页解析器；
- 绕过 1688 登录、验证码或风控；
- 图数据库；
- Redis、Kafka 或 Kubernetes；
- 依赖 S3、OSS、R2 才能运行；
- 自动认领到 TikTok 采集箱；
- 自动发布到 TikTok Shop；
- 其他电商平台；
- 自动生成原始证据中不存在的商品事实。

## 20. Confirmed Decisions

- 全新 `tk-commerce-workbench` 仓库，不改造旧应用；
- 模块化 TypeScript Monorepo；
- 本地单用户，无账号登录；
- 1688 店铺预览后只采集勾选商品；
- 妙手 `fetch_item` 是主采集器，扩展只提交勾选链接；
- 重复采集返回 skip 时按 source item ID 复用已有 success 详情；
- 本地文件为永久素材来源，外部 URL 仅临时中转；
- 商品采集后停留在商品池，由“开始处理”或“批量开始处理”触发自动化；
- 开始处理后到最终预览之间全自动；
- TikTok Shop 泰国站为首发站点；
- 目标语言可自定义，默认 `th-TH`；
- OpenAI-compatible 模型可替换，并有规则降级；
- 定价公式自动计算，汇率自动更新且可手动覆盖；
- 模板素材库支持品类匹配和参考图；
- Canvas 输入容量动态读取，当前九槽不是固定合同；
- 正常期望五张生成图，部分结果保留；
- 最终确认编辑同一条妙手公共采集箱商品；不认领、不进入 TikTok 采集箱、不发布；
- 正常路径包含“开始处理”和“确认并推送妙手”两个明确人工动作。
- 商品工作台采用“顶部阶段看板 + 高密度表格 + 右侧详情抽屉”的融合布局；看板用于状态总览和筛选，不提供拖拽改状态。
