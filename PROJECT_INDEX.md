# 项目索引：tk-commerce-workbench

生成时间：2026-08-11

## 📁 项目结构

```
tk-commerce-workbench/                 # pnpm monorepo (pnpm@9.15.9, node 22)
├── apps/
│   ├── extension/                     # Chrome MV3 采集扩展（vite@8）
│   │   ├── public/manifest.json       # host: 1688.com / 127.0.0.1
│   │   └── src/{background,content,options,popup,shared}
│   ├── web/                           # Next.js 16 App Router（React 19）
│   │   └── src/app/{products,processing-rules,write-records,settings,tasks,templates,api/v1}
│   └── worker/                        # TypeScript 后台 worker（tsx）
│       └── src/{handlers,runtime}
├── packages/
│   ├── contracts/    # @tk/contracts  跨层共享：ids/states/commands/ports/jobs/errors
│   ├── config/       # @tk/config     环境变量 + zod 校验（env.ts）
│   ├── domain/       # @tk/domain     纯领域逻辑：定价/选品/匹配/审批/状态
│   ├── db/           # @tk/db         drizzle-orm + pglite，含 11 个 repository
│   └── adapters/     # @tk/adapters   外部端口实现：miaoshou/canvas/llm/exchange/staging
├── docs/             # product / operations / development / superpowers(plans/specs/reports)
├── e2e/              # Playwright 端到端（6 个 spec）
├── tests/foundation/ # workspace 与 tooling-gates
├── scripts/          # 本地启动/测试/校验脚本
└── docker-compose.yml# postgres:16-alpine（127.0.0.1:5432）
```

## 🚀 入口点

- CLI（worker）：`apps/worker/src/cli.ts` — `pnpm --filter @tk/worker dev` / `start`
- Worker 装配：`apps/worker/src/main.ts` — `buildHandlerRegistry` + 限流/原子化包装
- Worker 运行时：`apps/worker/src/runtime/worker-loop.ts` — 任务循环与恢复
- Web 入口：`apps/web/src/app/layout.tsx` + `app/page.tsx` → `<ProductWorkbench>`
- Web API：`apps/web/src/app/api/v1/**/route.ts`（Next.js Route Handlers）
- Extension SW：`apps/extension/src/background/index.ts`
- Extension content：`apps/extension/src/content/index.ts`
- 测试入口：`scripts/run-tests.mjs`（统一测试编排）

## 📦 核心模块

### 模块：@tk/contracts

- 路径：`packages/contracts/src/`
- 导出：`ids, quantities, states, errors, commands, read-models, jobs, ports, source-url`
- 用途：跨应用层的类型/端口契约（zod 校验）

### 模块：@tk/domain

- 路径：`packages/domain/src/`
- 导出：`pricing`, `product/quality+revision`, `state/project-ui-stage`, `listing`, `assets`, `templates/match-template`, `automation/graph`, `approval/create-snapshot+invalidate-approval`
- 用途：纯函数领域逻辑（定价、选品、模板匹配、状态机）

### 模块：@tk/db

- 路径：`packages/db/src/`
- 导出：`schema`, 10 个 repository（approval/asset/audit/automation-run/canvas-quota/catalog/exchange-rate/job/local-capture/pipeline），`content-addressed-store`，`bootTestDb`
- 用途：drizzle-orm 数据访问 + pglite 测试 harness

### 模块：@tk/adapters

- 路径：`packages/adapters/src/`
- 导出：`miaoshou/{client,source-adapter,edit-adapter,edit-mapper,reconcile-edit}`, `canvas`, `llm/openai-compatible`, `exchange-rate`, `staging`, `security/safe-image-download`, `factory`, `testing/fakes`
- 用途：实现 contracts 中的 port，含 mock 与 live 双模式

### 模块：@tk/config

- 路径：`packages/config/src/`
- 导出：`env`（基于 process.env + 手写 helper 校验 `require_`/`parseIntStrict`/`ensureLoopbackUnlessAllowLan`，无 zod）
- 用途：本地/测试/生产的统一环境变量入口

### 模块：apps/worker（handlers）

- 路径：`apps/worker/src/handlers/`
- 模块：`miaoshou_collect`, `miaoshou_prepare_writeback`, `archive_assets`, `generate_listing`, `calculate_pricing`, `refresh_exchange_rate`, `match_template`, `select_images`, `generate_canvas`, `final_preview`, `staging_cleanup`, `miaoshou_edit`
- 用途：每个 handler 对应 worker-loop 的一种 job；**注意 handler 文件名 ≠ Job kind**（如 kind `asset_archive` 由 `archive-assets.ts` 处理，12 类 `JobKind` 定义于 `@tk/contracts`）

### 模块：apps/web（pages）

- 路径：`apps/web/src/app/`
- 页面：`/`, `/products/[id]`, `/products/[id]/review`, `/processing-rules`, `/write-records`, `/settings`, `/tasks`, `/templates`
- 用途：本地产品工作台 UI（侧栏导航在 `components/navigation/sidebar.tsx`）

### 模块：apps/extension

- 路径：`apps/extension/src/`
- 组成：`background/{index,capture-queue,chrome-capture-tab-port,submit-selected}`, `content/{index,detail-parser,scan-store,store-overlay,page-context-bridge,page-image-selection,normalize-1688-url}`
- 用途：1688 商品选择 → 提交到本地 ingest API（`/api/v1/ingest-links`）

## 🔧 配置

- `.env.example`：登记所有环境变量名（DATABASE_URL/TEST_DATABASE_URL/LOCAL_OPERATOR_ID/EXTENSION_TOKEN/ALLOW_LAN/EXTERNAL_ADAPTER_MODE 等）
- `docker-compose.yml`：postgres:16-alpine，仅监听 127.0.0.1:5432
- `eslint.config.mjs`、`tsconfig.base.json`、`vitest.config.ts`、`playwright.config.ts`、`pnpm-workspace.yaml`
- `scripts/postgres-init.sql`：主库 + 测试库初始化
- `scripts/local-production-config.mjs`、`scripts/local-production-runtime.mjs`：本地 full-live 启动
- `apps/web/next.config.ts`、`apps/extension/vite.config.ts`、`apps/web/src/server/composition.ts`

## 📚 文档

- `MEMORY.md`：项目核心全局记忆库（架构拓扑、实测基线、踩坑指南、演进清单）
- `docs/product/positioning-and-features.md`：产品定位
- `docs/product/pending-issues.md`：实测发现的待解决问题与技术债务清单
- `docs/product/frontend-ux-audit-kiss-yagni.md`：商品界面前端体验走查报告（KISS 与 YAGNI）
- `docs/operations/local-production.md`：本地生产模式
- `docs/operations/recovery.md`：worker 恢复与重启
- `docs/operations/security.md`：token / loopback / secret 安全
- `docs/development/local-setup.md`：本地启动步骤
- `docs/development/extension-install.md`：浏览器扩展安装
- `docs/development/agent-ownership.md`：Agent 工作区所有权
- `docs/superpowers/specs/`、`docs/superpowers/plans/`、`docs/superpowers/reports/`：规格/计划/复盘

## 🧪 测试覆盖

- 单元/组件测试：94 个 `*.test.ts(x)` 文件（vitest）
- 集成测试：`packages/db/test:integration`（pglite）+ `apps/worker/test:integration`
- E2E：6 个 Playwright spec（`e2e/*.spec.ts`），含 `full-mocked-flow`、`worker-recovery`、`browser-workbench`、`ui-context`、`workbench-fixed-samples`、`collection-to-product-pool`
- 入口：`pnpm test` → `scripts/run-tests.mjs`；`pnpm test:e2e` → `playwright test`

## 🔗 关键依赖

- 运行时：Next.js 16.2.10、React 19.2.7、drizzle-orm 0.45.2、zod 4.4.3、undici 7.28.0、decimal.js 10.6.0
- 工具链：pnpm 9.15.9、Node 22、TypeScript 5.9.3、vitest 4.1.10、playwright 1.61.1、vite 8.1.4、eslint 10.7.0
- 测试 DB：`@electric-sql/pglite` 0.5.x（轻量 Postgres）
- 全部内部包以 `workspace:*` 互引

## 📝 快速开始

1. **环境**：`.env.example` 复制为 `.env`，至少填 `DATABASE_URL`、`TEST_DATABASE_URL`、`LOCAL_OPERATOR_ID`、`EXTENSION_TOKEN`；`ALLOW_LAN=false`
2. **启动 DB**：`docker compose up -d postgres`（或本地 Postgres + `scripts/postgres-init.sql`）
3. **迁移 + 安装**：`pnpm install` → `pnpm db:migrate`
4. **运行**：`pnpm dev`（并行启动 `@tk/web` + `@tk/worker`）；扩展另需 `pnpm --filter @tk/extension build`
5. **测试**：`pnpm test`（单元/集成）或 `pnpm test:e2e`（端到端）
6. **本地 full-live**：`pnpm start:local`（要求 `LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp`）