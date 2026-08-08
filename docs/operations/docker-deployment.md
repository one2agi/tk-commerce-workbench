# Docker 开发与部署手册

本文适用于两种场景：

- 本机开发：Web、Worker、PostgreSQL 全部在 Docker 中运行；修改当前源码后自动热重载。
- VPS / 其他电脑：只运行已经构建好的固定版本镜像，不挂载源码，便于升级和回滚。

## 运行结构与数据边界

| 内容 | 本机开发 | 线上 / 其他电脑 |
|---|---|---|
| Web、Worker | `tk-commerce-workbench:dev`，挂载源码并热重载 | 两个带版本号的不可变镜像 |
| PostgreSQL | Docker volume `tk-commerce-workbench_postgres_data` | 同名 Docker volume |
| 素材 | 宿主机 storage 下的 `data/assets` | 宿主机明确指定的持久化目录 |
| 配置与密钥 | 宿主机 storage 下的 `.env`，只注入容器 | 目标机器上的 `.env`，不打进镜像 |
| 对外端口 | 默认仅 `127.0.0.1:3000` | 默认仅 loopback；通过 SSH 本地隧道访问 |

镜像、源码、数据库和素材相互独立。升级镜像不会删除数据库或素材；`down` 命令也禁止携带 `--volumes`。

## 本机开发

### 前置条件

- Docker Desktop / Docker Engine 已启动，并支持 `docker compose`。
- 当前机器已存在运行时配置：`~/.local/share/tk-commerce-workbench/.env`。
- 当前机器已存在素材目录：`~/.local/share/tk-commerce-workbench/data/assets`。
- 当前 PostgreSQL 数据卷名为 `tk-commerce-workbench_postgres_data`。

如果需要使用不同的 storage 根目录，只为当前命令设置 `TK_WORKBENCH_STORAGE_DIR`。目录内仍须包含 `.env` 和 `data/assets`：

```bash
TK_WORKBENCH_STORAGE_DIR=/srv/tk-workbench pnpm docker:dev:up
```

### 首次切换到全 Docker

```bash
pnpm docker:dev:up
```

首次执行会按以下顺序工作：

1. 检查 Docker、运行时 `.env`、素材目录和既有 PostgreSQL volume；若检测到宿主机版 Web / Worker 的运行记录或 Worker 进程则拒绝继续，并提示先使用原停止入口关闭它们。
2. 停止仍在运行的旧 Web / Worker，阻断新写入；在任何数据库迁移之前，把 PostgreSQL 与素材打包成同一批次备份。
3. 构建开发镜像，启动 PostgreSQL，执行迁移，再启动 Web 和 Worker。
4. Web 健康检查成功后，才记录迁移已完成标记。

成功后访问 `http://127.0.0.1:3000`。

### 热重载范围

修改以下目录会由容器内开发进程自动加载，无需重建镜像：

- `apps/web/src`
- `apps/worker/src`
- `packages/adapters/src`
- `packages/config/src`
- `packages/contracts/src`
- `packages/db/src`
- `packages/domain/src`

以下内容改变后需要重新执行 `pnpm docker:dev:up`，让开发镜像重建：

- `package.json`、`pnpm-lock.yaml`、workspace 配置
- Dockerfile 或 Compose 文件
- Next.js / TypeScript 等构建配置
- 新增不在上述挂载范围内的源目录

### 日常命令

```bash
# 状态和 Web 健康信息
pnpm docker:status

# 查看全部日志；指定服务时直接调用底层入口
pnpm docker:logs
node scripts/docker-local.mjs dev:logs web
node scripts/docker-local.mjs dev:logs worker

# 安全停止；保留 PostgreSQL volume 和素材
pnpm docker:dev:down

# 手工创建数据库 + 素材成对备份；期间会短暂停止 Web / Worker，完成后自动恢复
pnpm docker:backup
```

## 备份与恢复

默认备份目录为：

```text
~/.local/share/tk-commerce-workbench/data/backups/<UTC时间>/
├── postgres.dump
├── assets.tar.gz
└── manifest.json
```

`manifest.json` 保存版本、数据卷名、文件大小和 SHA-256，用于确认数据库和素材确实来自同一批次；它不保存密钥值。

备份命令会先确认既有 volume 存在，并核对 PostgreSQL 容器实际挂载的正是该 volume；不会为了备份自动创建空数据卷。为了让数据库与素材对应同一业务时间点，命令会短暂停止当前正在运行的 Web / Worker，备份成功或失败后都会恢复它们。任一阶段失败时，整个临时批次都会清理，不会留下可被误认成成功备份的半成品。首次 Docker 迁移是例外：旧应用会保持停止，随后直接启动新容器，避免备份后到迁移前再次写入。

恢复是高影响操作，先停止 Web 和 Worker，并把当前数据再备份一份。先用 `sha256sum postgres.dump assets.tar.gz` 计算两个文件摘要，并逐项与 `manifest.json` 中的值比较；任一不一致都停止恢复。确认目标批次后执行：

```bash
# 只启动 PostgreSQL
docker compose -p tk-commerce-workbench -f docker-compose.yml up -d --wait postgres

# 恢复数据库（会覆盖同名对象，请先确认目标数据库）
docker compose -p tk-commerce-workbench -f docker-compose.yml exec -T postgres \
  pg_restore -U postgres -d tk_workbench --clean --if-exists \
  --exit-on-error --single-transaction \
  < /绝对路径/备份批次/postgres.dump

# 恢复素材；先移走旧目录，再以容器 node 用户的 UID/GID 创建空目录
mv ~/.local/share/tk-commerce-workbench/data/assets \
  ~/.local/share/tk-commerce-workbench/data/assets.before-restore
install -d -o 1000 -g 1000 -m 700 \
  ~/.local/share/tk-commerce-workbench/data/assets
tar -xzf /绝对路径/备份批次/assets.tar.gz \
  -C ~/.local/share/tk-commerce-workbench/data/assets
```

恢复后重新启动对应环境，并抽查商品数、任务状态和素材可访问性。

## 构建生产镜像

默认镜像版本取当前 Git 短提交号：

```bash
pnpm docker:prod:build
```

构建只依赖源码与 Docker，不要求构建机已有运行时 `.env` 或素材目录。为保证版本可审计，工作树有未提交文件时构建会拒绝执行。

也可以显式指定发布版本：

```bash
TK_IMAGE_TAG=2026.08.08-1 pnpm docker:prod:build
```

产出：

- `tk-commerce-workbench-web:<版本>`
- `tk-commerce-workbench-worker:<版本>`

生产镜像不包含项目 `.env`、本地数据、素材或 Git 历史。

## 部署到 VPS 或其他电脑

### 目标机器准备

1. 安装 Docker Engine 和 Compose 插件。
2. 放置本仓库的 `docker-compose.yml`、`compose.prod.yml` 和 `scripts/postgres-init.sql`；不需要挂载源码运行，也不要求目标机安装 Node.js / pnpm。
3. 创建持久化目录，例如 `/srv/tk-workbench`：

```bash
install -d -o 1000 -g 1000 -m 700 /srv/tk-workbench/data/assets
chmod 700 /srv/tk-workbench /srv/tk-workbench/data
```

4. 把运行时 `.env` 放到 `/srv/tk-workbench/.env`，权限设为 `0600`。不要把它提交到 Git、复制进镜像或打印到日志。

生产环境中 Compose 会把数据库地址和素材容器路径固定为 Docker 内部地址；其余业务配置继续从目标机器的 `.env` 注入。

Compose 会在应用容器内把 `ALLOW_LAN` 覆盖为 `true`，仅用于允许访问 Docker 私有网络里的 `postgres` 服务名。它不决定 Web 的监听范围；宿主机是否对外开放仍只由 `TK_WEB_BIND_IP` 控制，默认值是 `127.0.0.1`。

### 方式一：使用镜像仓库

构建机给镜像增加仓库标签并推送：

```bash
docker tag tk-commerce-workbench-web:2026.08.08-1 registry.example.com/tk/workbench-web:2026.08.08-1
docker tag tk-commerce-workbench-worker:2026.08.08-1 registry.example.com/tk/workbench-worker:2026.08.08-1
docker push registry.example.com/tk/workbench-web:2026.08.08-1
docker push registry.example.com/tk/workbench-worker:2026.08.08-1
```

目标机器拉取镜像后，使用环境变量告诉 Compose 仓库地址和版本：

```bash
export TK_IMAGE_TAG=2026.08.08-1
export TK_WEB_IMAGE=registry.example.com/tk/workbench-web
export TK_WORKER_IMAGE=registry.example.com/tk/workbench-worker
export TK_WORKBENCH_ENV_FILE=/srv/tk-workbench/.env
export TK_WORKBENCH_ASSET_DIR=/srv/tk-workbench/data/assets
docker compose -p tk-commerce-workbench \
  -f docker-compose.yml -f compose.prod.yml up -d --wait
```

### 方式二：离线镜像包

构建机导出两个生产镜像：

```bash
TK_IMAGE_TAG=2026.08.08-1 pnpm docker:image:export -- /绝对路径/tk-workbench-2026.08.08-1.tar
```

将 tar 文件和部署文件复制到目标机器，然后导入并启动。离线包使用默认镜像名，因此无需设置仓库地址：

```bash
docker load -i /绝对路径/tk-workbench-2026.08.08-1.tar
export TK_IMAGE_TAG=2026.08.08-1
export TK_WORKBENCH_ENV_FILE=/srv/tk-workbench/.env
export TK_WORKBENCH_ASSET_DIR=/srv/tk-workbench/data/assets
docker compose -p tk-commerce-workbench \
  -f docker-compose.yml -f compose.prod.yml up -d --wait
```

### 远程访问入口

当前产品仍是单用户 loopback 安全模型，Host 和写操作 Origin 都必须是 loopback。它**不支持**直接通过公网域名、Caddy / Nginx / Cloudflare Tunnel 操作，也不应设置 `TK_WEB_BIND_IP=0.0.0.0`。

在 VPS 或另一台电脑上运行时，保持默认 `127.0.0.1:3000`，从操作电脑建立 SSH 本地隧道：

```bash
ssh -N -L 3000:127.0.0.1:3000 user@your-vps
```

然后只访问操作电脑上的 `http://127.0.0.1:3000`。未来若需要公网多用户访问，必须先增加正式认证、可信代理与 CSRF/Origin 设计，不属于本方案。

## 升级与回滚

升级前先创建数据库与素材成对备份。若服务器上有本仓库及 Node.js / pnpm，可使用管理脚本；它会自动进入短暂维护窗口：

```bash
TK_WORKBENCH_STORAGE_DIR=/srv/tk-workbench pnpm docker:backup
```

若目标机只有 Docker，使用下面的 Docker-only 流程。先停止写入，再把两个文件放进同一个批次目录；任何一步失败都不要把该目录视为可恢复备份：

```bash
export TK_IMAGE_TAG=2026.08.08-1 # 替换为当前正在运行的版本
export TK_WORKBENCH_ENV_FILE=/srv/tk-workbench/.env
export TK_WORKBENCH_ASSET_DIR=/srv/tk-workbench/data/assets
(
  set -eu
  tk_compose() {
    docker compose -p tk-commerce-workbench \
      -f docker-compose.yml -f compose.prod.yml "$@"
  }
  TK_RUNNING_SERVICES=$(tk_compose ps --services --status running | \
    awk '$0 == "web" || $0 == "worker"')
  TK_BACKUP_ROOT=/srv/tk-workbench/data/backups
  install -d -m 700 "$TK_BACKUP_ROOT"
  TK_BACKUP_PARTIAL=$(mktemp -d "$TK_BACKUP_ROOT/.partial-XXXXXXXX")
  tk_cleanup() {
    tk_status=$?
    trap - EXIT
    rm -rf -- "$TK_BACKUP_PARTIAL"
    if [ -n "$TK_RUNNING_SERVICES" ]; then
      # 只恢复备份前实际在运行的服务，不唤醒原本停用的任务。
      tk_compose start $TK_RUNNING_SERVICES || tk_status=$?
    fi
    exit "$tk_status"
  }
  trap tk_cleanup EXIT
  tk_compose stop web worker
  tk_compose exec -T postgres \
    pg_dump -U postgres -d tk_workbench -Fc > "$TK_BACKUP_PARTIAL/postgres.dump"
  tk_compose exec -T postgres pg_restore --list \
    < "$TK_BACKUP_PARTIAL/postgres.dump" > /dev/null
  tar -czf "$TK_BACKUP_PARTIAL/assets.tar.gz" \
    -C /srv/tk-workbench/data/assets .
  (
    cd "$TK_BACKUP_PARTIAL"
    sha256sum postgres.dump assets.tar.gz > SHA256SUMS
  )
  TK_BACKUP_BATCH="$TK_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${TK_BACKUP_PARTIAL##*-}"
  mv "$TK_BACKUP_PARTIAL" "$TK_BACKUP_BATCH"
  echo "Backup ready: $TK_BACKUP_BATCH"
)
```

确认备份完整后，记录当前版本和批次，再导入 / 拉取新镜像，并以新 tag 启动：

```bash
export TK_IMAGE_TAG=2026.08.08-2
export TK_WORKBENCH_ENV_FILE=/srv/tk-workbench/.env
export TK_WORKBENCH_ASSET_DIR=/srv/tk-workbench/data/assets
docker compose -p tk-commerce-workbench \
  -f docker-compose.yml -f compose.prod.yml up -d --wait
```

回滚应用版本时使用上一版 `TK_IMAGE_TAG` 再次启动。若新版本已经执行不可逆数据库迁移，仅回滚镜像不够，必须使用升级前的数据库与素材成对备份恢复。

## 排障

| 现象 | 处理 |
|---|---|
| `Docker daemon is unavailable` | 启动 Docker Desktop / Docker Engine 后重试 |
| `.env` 或素材目录 missing | 检查 `TK_WORKBENCH_STORAGE_DIR` 是否指向正确的持久化根目录 |
| PostgreSQL volume missing（开发模式） | 本机开发要求沿用现有卷；先用 `docker volume ls` 确认卷名，避免误建空库 |
| `127.0.0.1:3000` 被占用 | 停止旧宿主机 Web；或设置 `TK_WEB_PORT=3001` 后启动 |
| Web 健康检查失败 | `node scripts/docker-local.mjs dev:logs web` 查看 Web 日志，同时检查迁移服务日志 |
| Worker 未工作 | `node scripts/docker-local.mjs dev:logs worker`，确认 `.env` 中业务配置完整 |
| 生产启动提示 `TK_IMAGE_TAG is required` | 显式指定已经存在于目标机器上的镜像版本 |

## 安全约束

- 不使用 `docker compose down -v`，也不要手工删除 `tk-commerce-workbench_postgres_data`。
- 不把 `.env`、数据库 dump、素材备份和镜像离线包提交到 Git。
- 对外部署默认只监听 loopback；当前版本只允许通过 SSH 本地隧道访问，不直接接入公网反向代理。
- 每次迁移或升级都把 PostgreSQL 和素材作为同一恢复单元。
