# Docker 本地开发与跨主机部署设计

## 背景与目标

当前项目的 `docker-compose.yml` 只运行 PostgreSQL，Web 与 Worker 由宿主机脚本启动。目标是把 Web、Worker、PostgreSQL 全部放入 Docker，同时满足以下要求：

- 在当前 `main` worktree 修改 Web、Worker 或共享包源码后自动热重载。
- 无损沿用现有 PostgreSQL 数据和素材目录。
- 本地开发配置不能削弱生产安全边界。
- 同一套镜像构建基础可以部署到 VPS 或其他安装了 Docker 的电脑。
- 提供完整的中文部署、启动、备份、恢复与排障说明。

## 已确认的现有数据

- PostgreSQL Docker 卷：`tk-commerce-workbench_postgres_data`。
- 素材目录：`/home/morav/.local/share/tk-commerce-workbench/data/assets`。
- 本机运行环境文件：`/home/morav/.local/share/tk-commerce-workbench/.env`。
- Web 对外入口继续限制为 `127.0.0.1:3000`。

数据库与素材是配套的业务事实来源，迁移、备份和恢复必须使用同一时间点的数据。

## 方案选择

采用“开发与生产双模式”的全 Docker 方案。

未采用的方案：

- Compose Watch 重建模式：反馈速度慢，不适合日常 TS/TSX/CSS 开发。
- 容器启动时在整个宿主机工作区安装依赖：会污染工作区，并显著增加启动时间。
- Web/Worker 留在宿主机：无法满足全部服务进入 Docker 的要求。

## 镜像设计

使用一个多阶段 `Dockerfile`：

1. `base`：Node.js 22、Corepack、pnpm 和工作区基础文件。
2. `deps`：依据锁文件安装固定依赖。
3. `dev`：供 Web 和 Worker 开发容器复用，包含开发依赖。
4. `builder`：构建 Next.js 生产产物并完成必要的 TypeScript 构建检查。
5. `web-runner`：仅包含 Web 生产运行所需文件和依赖。
6. `worker-runner`：仅包含 Worker 生产运行所需文件和依赖。

镜像构建上下文不得包含以下内容：

- `.env` 或任何 secrets 文件。
- `data/`、本机素材和数据库文件。
- `node_modules`、`.next`、测试输出和本机运行日志。
- Git 元数据和无关设计素材。

这些排除规则由 `.dockerignore` 固化。

## Compose 结构

### 基础服务

Compose 包含四类服务：

- `postgres`：PostgreSQL 16，提供数据库健康检查。
- `migrate`：等待 PostgreSQL 健康后执行数据库迁移，成功退出后才允许应用启动。
- `web`：运行 Next.js Web。
- `worker`：运行后台任务 Worker，不暴露宿主机端口。

Web 和 Worker 使用同一个 Git commit 对应的镜像版本，避免前后端代码版本不一致。

### 开发模式

开发配置使用 `compose.dev.yml`：

- Web 运行 Next.js 开发模式，容器内监听 `0.0.0.0:3000`，宿主机映射仍为 `127.0.0.1:3000`。
- Worker 运行 `tsx watch`，源码变化时重启 Worker 子进程，不重建容器。
- 挂载 Web、Worker 和各共享包的 `src` 目录；新增源码文件也能即时进入容器。
- 挂载 Web 公共资源目录和热重载必需的项目配置文件。
- 开启 Watchpack/Chokidar 轮询，保证 `/mnt/d` 上的 Windows 文件变化能够被 Docker Desktop 稳定发现。
- 依赖保留在镜像中；Next.js 构建缓存使用独立 Docker 缓存卷，不在宿主机产生 `node_modules` 或 `.next`。

普通 TS、TSX、CSS 和共享包源码修改直接热重载。修改 `package.json`、`pnpm-lock.yaml`、Dockerfile 或构建配置后，需要显式重建开发镜像。

### 生产模式

生产配置使用 `compose.prod.yml`：

- 使用 `web-runner` 和 `worker-runner`，不挂载源码，不包含开发依赖。
- Web 只暴露必需端口；PostgreSQL 默认只在 Compose 内网可见。
- Web、Worker、PostgreSQL 配置健康检查和 `unless-stopped` 重启策略。
- 镜像使用不可变版本标签，至少包含 Git commit 短 SHA；不使用裸 `latest` 作为唯一部署标识。
- 保留上一个可用镜像标签，用于应用层快速回滚。

## 数据与配置挂载

### PostgreSQL

本机开发直接复用外部卷 `tk-commerce-workbench_postgres_data`。Compose 将该卷声明为 external，避免 `docker compose down -v` 删除现有业务数据。

首次切换前必须：

1. 确认当前 PostgreSQL 容器健康。
2. 使用 `pg_dump` 生成带时间戳的逻辑备份。
3. 记录数据库备份与素材快照时间。
4. 只有备份成功后才允许执行迁移。

VPS 或其他电脑使用目标主机自己的 PostgreSQL 卷。跨主机迁移通过 `pg_dump`/`pg_restore` 完成，不复制 PostgreSQL 内部数据目录。

### 素材

本机把现有素材目录绑定挂载到容器内固定路径 `/app/data/assets`，并覆盖容器环境中的 `ASSET_ROOT`。

生产主机使用目标机器上的持久目录，例如 `/opt/tk-commerce-workbench/data/assets`。跨主机部署时复制素材目录，并与数据库备份使用同一快照时间。

### 环境变量与密钥

本机继续使用现有 storage `.env`，Compose 只把变量注入 Web、Worker 和迁移服务，不把文件复制进镜像。

容器内覆盖以下地址：

- `DATABASE_URL` 指向 `postgres:5432/tk_workbench`。
- `TEST_DATABASE_URL` 指向 `postgres:5432/tk_workbench_test`。
- `ASSET_ROOT` 指向 `/app/data/assets`。

Canvas、LLM、汇率、生图和妙手配置继续来自目标主机的 `.env`。如果将来某个外部服务运行在 Docker 宿主机的 loopback，应使用 `host.docker.internal` 或同一 Compose 网络中的服务名，不能在容器内继续使用 `127.0.0.1`。

## 启动与管理入口

提供统一脚本或 package scripts，覆盖：

- 开发环境构建与启动。
- 开发环境停止、状态和日志。
- 生产镜像构建与生产 Compose 启动。
- PostgreSQL 与素材的配套备份。
- 镜像导出、导入和目标机器启动。

入口必须执行预检：

- Docker daemon 和 Compose 可用。
- 环境文件存在且权限合理。
- 本机开发所需的 external PostgreSQL 卷存在。
- 素材目录存在并可写。
- `127.0.0.1:3000` 没有被非 Compose 进程占用。

预检失败时返回明确错误，不自动删除数据、不自动杀死未知进程，也不输出 secrets。

## 启动顺序与失败处理

启动顺序固定为：

1. PostgreSQL 启动并通过健康检查。
2. `migrate` 执行迁移并成功退出。
3. Web 与 Worker 启动。
4. Web `/api/runtime-health` 和 Worker readiness 通过后，启动命令才报告成功。

失败处理：

- 数据库备份失败：停止流程，不迁移。
- 数据库迁移失败：Web 与 Worker 不启动。
- Web 或 Worker 不健康：保留日志，启动命令返回失败，不删除数据卷。
- 端口冲突：停止流程并报告占用信息，不自动杀进程。
- `.env` 或素材目录缺失：停止流程并报告确切路径。
- 普通停止只删除容器和临时网络；外部数据库卷、素材目录和备份不删除。

## 部署与迁移

支持两种镜像交付方式：

1. 推送到私有或公开镜像仓库，目标机器按固定版本标签拉取。
2. 使用 `docker save` 导出镜像包，复制到目标机器后通过 `docker load` 导入。

目标机器部署包包括：

- `compose.prod.yml` 及必要的基础 Compose 文件。
- 不含真实值的环境变量示例。
- 目标机器自行创建的真实 `.env`。
- 数据库备份文件和同时间点素材备份。
- 部署启动说明。

升级流程先备份，再拉取或导入新镜像，执行迁移，最后替换 Web 与 Worker。应用回滚使用上一镜像标签；如果迁移不兼容旧版本，则同时恢复升级前数据库与素材备份。

## 验收标准

### 本地开发验收

- Web、Worker、PostgreSQL 全部运行在 Docker 中。
- `http://127.0.0.1:3000` 和 `/api/runtime-health` 返回成功。
- 修改 Web TSX/CSS 后，不重建镜像即可看到刷新。
- 修改 Worker 或共享包源码后，Worker 子进程自动重启，容器 ID 不变。
- 停止并重新创建容器后，数据库记录和素材仍存在。
- 当前数据库与素材在切换前后通过抽样校验。

### 生产验收

- 生产镜像可独立构建。
- 生产 Compose 能完成 PostgreSQL 健康检查、迁移、Web 和 Worker 启动。
- 生产容器不挂载源码，不包含本机 `.env`、密钥或业务素材。
- Web 与 Worker 镜像版本一致。
- 备份、恢复和上一版本回滚流程至少完成一次演练。

## 文档交付

新增 `docs/operations/docker-deployment.md` 中文说明，至少包含：

- 本地热重载环境的构建、启动、停止、状态与日志命令。
- 首次无损沿用现有 PostgreSQL 卷和素材目录的步骤。
- 修改源码与修改依赖时分别需要执行什么操作。
- VPS/其他电脑的镜像构建、仓库拉取、离线导出、导入和启动流程。
- `.env`、素材目录和数据库卷的准备方式。
- 数据库与素材的备份、恢复、升级和回滚。
- 端口冲突、文件权限、数据库连接、健康检查和热重载排障。

## 非目标

- 本次不改为 Kubernetes。
- 本次不把本地素材迁移到对象存储。
- 本次不引入在线 CI/CD 平台或镜像仓库账号。
- 本次不开放局域网或公网数据库端口。
- 本次不改变现有业务流程、外部 Adapter 行为或人工确认边界。
