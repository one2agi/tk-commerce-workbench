# TK Commerce Workbench

面向 TikTok Shop 跨境运营的本地 AI 商品处理台。它把 1688 商品从「采集成功」到「妙手公共采集箱待发布素材准备好」之间的重复工作自动串起来:采集、标题清洗、本地化、定价、Canvas `TK工作流` 生图、人工确认、写回妙手。

产品不是跨境 ERP,也不是单纯采集插件或 AI 生图工具,而是**妙手前置的 AI 上架准备层**。

## 核心流程

```text
浏览器勾选 1688 商品
→ 提交到本地工作台
→ 商品进入待处理
→ 用户点击开始处理
→ 系统自动完成采集详情、标题、定价、选图、Canvas 生图
→ 商品进入待确认
→ 用户确认写回妙手
→ 同一条妙手 canonical 公共采集箱商品被编辑
```

MVP 原则是「自动处理,人工确认写回」,只保留两道人工边界:

1. **开始处理** —— 费用边界,点击后才允许调用 LLM、汇率、Canvas 生图等可能产生费用的能力;
2. **确认写回妙手** —— 外部写入边界,点击后才允许编辑妙手商品。

## 功能特性

- **1688 浏览器扩展采集**:在 1688 商品列表/店铺页扫描商品卡片,批量勾选,通过本地 Bearer Token 提交到工作台
- **妙手采集与详情导入**:按 canonical 商品去重,写回时编辑同一条妙手公共采集箱商品,避免重复创建
- **自动标题与 Listing**:清洗 1688 供应商噪音,生成目标语言标题,支持自定义语言与标题风格
- **自动定价**:按公式计算售价,支持汇率、利润率、平台费、运费、溢价等参数
- **Canvas `TK工作流` 生图**:基于商品图生成结构化电商素材(主图、卖点证明图、场景价值图、细节结构图等),输出本地归档可预览
- **商品处理台**:状态展示与批量操作(待处理 → 自动处理中 → 待确认 → 写回妙手中 → 已完成 → 需要人工处理)
- **写回记录**:区分「已采集到妙手」与「已编辑回妙手」,失败提供可读原因与重试入口
- **全程状态持久化**:任务失败可重试、可诊断,不因重复点击产生重复费用或重复商品

## 技术栈

| 层 | 技术 |
| --- | --- |
| 工程 | pnpm monorepo · Node 22 · TypeScript 5.9 |
| 采集 | Chrome MV3 扩展(vite 8) |
| Web | Next.js 16 App Router · React 19 |
| Worker | TypeScript 后台任务循环(tsx) |
| 数据 | drizzle-orm · PostgreSQL 16 · pglite(测试) |
| 测试 | vitest 4 · Playwright 1.61 · eslint 10 |

## 快速开始

前置条件:Node.js 22、Docker、Corepack。

```bash
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
```

复制 `.env.example` 为 `.env`,至少填写 `DATABASE_URL`、`TEST_DATABASE_URL`、`LOCAL_OPERATOR_ID`、`EXTENSION_TOKEN`;开发阶段保持 `ALLOW_LAN=false`、`EXTERNAL_ADAPTER_MODE=mock`。

```bash
set -a
source .env
set +a
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev        # 并行启动 web + worker
```

Web 只监听 `127.0.0.1`。素材默认永久保存在 `ASSET_ROOT`,不要把 `data/` 加入 Git。

一次性验证全新环境: `bash scripts/verify-fresh-install.sh`

## 测试

```bash
pnpm test               # 单元/组件测试(vitest)
pnpm test:integration   # 集成测试(真实 PostgreSQL / pglite)
pnpm test:e2e           # Playwright 端到端
pnpm test:docker        # 部署脚本测试
pnpm lint && pnpm typecheck && pnpm build
```

## Docker 部署

完整手册见 [`docs/operations/docker-deployment.md`](docs/operations/docker-deployment.md):

- 本机开发(全 Docker、热重载)
- 构建生产镜像
- 部署到 VPS / 其他电脑(镜像仓库 / 离线镜像包两种方式)
- 备份与恢复(数据库 + 素材成对备份)
- 升级、回滚、排障、安全约束

单人单机生产模式见 [`docs/operations/local-production.md`](docs/operations/local-production.md)。

## 项目结构

```text
tk-commerce-workbench/
├── apps/
│   ├── extension/    # Chrome MV3 采集扩展(vite)
│   ├── web/          # Next.js 商品处理台 UI
│   └── worker/       # TypeScript 后台任务循环
├── packages/
│   ├── contracts/    # 跨层契约:ids/states/commands/ports/jobs
│   ├── config/       # 环境变量入口 + 校验
│   ├── domain/       # 纯领域逻辑:定价/选品/匹配/审批/状态
│   ├── db/           # drizzle-orm 数据访问 + repository
│   └── adapters/     # 外部端口实现:妙手/Canvas/LLM/汇率
├── docs/             # product / architecture / operations / development
├── e2e/              # Playwright 端到端
├── scripts/          # 启动/测试/部署脚本
└── docker-compose.yml # postgres:16-alpine
```

## 文档索引

- [`docs/product/positioning-and-features.md`](docs/product/positioning-and-features.md) — 产品定位与功能
- [`docs/architecture/`](docs/architecture/) — 系统设计、API 契约、数据字典
- [`docs/operations/`](docs/operations/) — 部署、本地生产、恢复、安全
- [`docs/development/`](docs/development/) — 本地搭建、扩展安装

## 安全说明

`.env` 含真实密钥,已被 `.gitignore` 排除,不会进入仓库;仓库只提供 `.env.example` 变量模板。本地扩展 Token 与外部服务凭据均通过环境变量注入。
