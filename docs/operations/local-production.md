# 本地生产（单人单机）

> 如果希望 Web、Worker 和 PostgreSQL 全部运行在 Docker 中，开发时自动热重载，并能把同一套镜像部署到 VPS 或其他电脑，请使用 [Docker 开发与部署手册](./docker-deployment.md)。本文保留的是宿主机直接运行 Node.js 的旧流程。

本目录文档描述在**同一台机器**上把工作台跑成“生产模式”的最小流程：浏览器扩展采集 → 本机 Web/Worker → 商品处理台。默认模式仍是 mock，不消耗外部额度；需要真实 MVP 验收时，可以显式切到 full-live 模式，调用真实 Canvas / LLM / 汇率 / 妙手。

## 谁应该用

- 单人单机演示 / 联调：完整跑通采集 → 选品 → 流水线（mock 收尾）。
- 真实 MVP 验收：显式 full-live，跑通本地 Canvas 8123 `TK工作流`、LLM、汇率和妙手写回。
- 集成测试与 E2E 在 CI 里跑，不依赖本机服务。

## 前置条件

- Node.js 22（与 `.node-version` 一致）、Corepack、Docker Desktop。
- PostgreSQL 容器 `tk-workbench-postgres`，端口 `127.0.0.1:5432`（见 `docker-compose.yml`）。
- `apps/extension/dist` 已构建（浏览器扩展侧载目录）。
- 本机运行时 storage env 已初始化（默认 `/home/<user>/.local/share/tk-commerce-workbench/.env`，权限 `0600`，见下文）。项目根 `.env` 可作为 full-live 的可信同步来源。

## 一次性初始化

> 该步骤只在首次或更换机器时执行。重复执行会因 `.env` 已存在而失败，这是预期行为。

```bash
# 1. 准备本机真实 secrets（不在仓库里）：
#    secrets 文件只用于本地初始化，命令结束后不要再读它。
node scripts/local-production-config.mjs /mnt/d/project/TKcaiji/TKskill/env.txt
```

该脚本会：

- 校验 secrets 文件路径（拒绝指向 `.env`、secrets 文件、worktree 等敏感目标）。
- 从 secrets 文件只读取键名，不评估其值。
- 写入运行时 storage env（`wx` 创建，权限 `0600`）。
- 创建 `data/runtime/`、`data/assets/` 等目录（权限 `0700`）。
- 生成随机的 `EXTENSION_TOKEN`（如 secrets 文件未提供）。
- 强制 `EXTERNAL_ADAPTER_MODE=mock`、`ALLOW_LAN=false`，不覆盖用户原值。

写入后请手工核对键名、文件权限（storage `.env` 必须 `0600`、数据目录必须 `0700`）。**不要**把 secrets 文件内容 `cat` 或 `source` 到 shell；初始化完成后建议 `shred -u /mnt/d/project/TKcaiji/TKskill/env.txt`（或同等安全删除）以免明文留在磁盘上。

## 构建扩展（首次或升级后）

```bash
pnpm --filter @tk/extension build
```

产物在 `apps/extension/dist/`。在 Chrome / Edge 打开 `chrome://extensions` → “加载已解压的扩展程序” → 选择 `apps/extension/dist`。每次重建后扩展会自动重载。

## 启动 / 状态 / 停止（默认 mock）

推荐入口是一键脚本，它会处理本机常见启动问题：

- 清理 `HTTP_PROXY` / `HTTPS_PROXY` 等代理变量，避免 Next CLI 在本地启动时卡住。
- 检查 `DATABASE_URL` 指向的 PostgreSQL 端口；如未启动，会尝试通过 Docker Compose 启动 `postgres` 服务。
- 执行数据库迁移。
- 检查已有 Web 生产构建；不存在时自动构建。
- 同时启动 Web `3000` 和 Worker，并等待 `/api/runtime-health` 就绪。

```bash
pnpm start:local
```

Windows 也可以双击项目根目录的：

```text
start-local-production.cmd
```

如果脚本提示 Docker daemon 不可用，请先手动打开 Docker Desktop，再重新运行该脚本。

高级/严格运行器仍保留如下：

```bash
# 启动（前台执行；命令返回代表 readiness 已通过）
node scripts/local-production-runtime.mjs start

# 查询当前 launchId、worker readiness、PG 健康等（只输出 JSON，不含 secrets）
node scripts/local-production-runtime.mjs status

# 优雅停机（SIGTERM → SIGKILL，全组清退）
node scripts/local-production-runtime.mjs stop
```

启动器做了：

- 校验 `.env` 存在、`ALLOW_LAN=false`、`DATABASE_URL` 已设置、`apps/web/.next/BUILD_ID` 存在。默认 `EXTERNAL_ADAPTER_MODE=mock`；full-live 需要额外显式确认，见下一节。
- 申请独占锁 `data/runtime/start.lock` 防并发启动。
- 生成当前 launchId（`TK_RUNTIME_LAUNCH_ID`）并写进子进程环境。
- Web：`pnpm --filter @tk/web start`；Worker：`env PGAPPNAME=tk-workbench-local-worker pnpm --filter @tk/worker start`。
- 等待 Web `http://127.0.0.1:3000/` 返回 2xx、Worker 写入 `data/runtime/worker-ready-<launchId>.json` 后才返回成功。
- 任何子进程日志命中“Authorization / APP Secret / 任一已注册 secret 名 / 数据库密码”时，停止两个进程组、删除 metadata、redact 日志并返回非零。
- 失败时把未成功清理的进程记录到 `data/runtime/processes.json` 的 `state: "recovery"`，下次启动会提示手工清理（避免误杀被 Linux 复用的 PGID）。

`status` 在完全就绪时输出形如：

```json
{
  "running": true,
  "webUrl": "http://127.0.0.1:3000/",
  "web": {
    "pid": 1234,
    "pgid": 1234,
    "startTimeTicks": "1234567",
    "marker": "tk-workbench-local-web",
    "launchId": "<base64url>"
  },
  "worker": {
    "pid": 1235,
    "pgid": 1235,
    "startTimeTicks": "1234568",
    "marker": "tk-workbench-local-worker",
    "launchId": "<base64url>",
    "baselineBackendPids": []
  }
}
```

未就绪时返回 `{ "running": false }`（无 metadata）或 `{ "running": false, "recovered": true }`（存在 recovery metadata，待手工清理）。字段集合固定，不出现任何 secrets、URL 中的密码或扩展 token。

## 真实 MVP 验收（显式 full-live）

full-live 只用于本机真实验收。它会真实调用 Canvas、LLM、汇率和妙手，因此必须通过 `LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp` 显式确认。即使 full-live，Web 与摄取 API 仍只允许 loopback，且最终妙手写回仍需要用户在详情页点击“确认写回妙手”。

推荐从项目根 `.env` 同步到运行时 storage env：

```bash
node scripts/local-production-config.mjs sync-live .env
pnpm --filter @tk/web build
node scripts/local-production-runtime.mjs stop
node scripts/local-production-runtime.mjs start
node scripts/local-production-runtime.mjs status
```

`sync-live` 只复制白名单运行变量，强制写入：

- `ALLOW_LAN=false`
- `EXTERNAL_ADAPTER_MODE=live`
- `LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp`

命令输出只包含 `set` / `empty` / `missing` 状态，不输出密钥值。`status` 应显示：

```json
{
  "adapterMode": "live",
  "canvasBaseUrlKind": "loopback",
  "canvasWorkflowName": "TK工作流"
}
```

前端点击验收路径：

1. 在 `/products` 中选择商品，点击“开始处理”或“批量重试”。
2. 等待商品从“自动处理中”进入“待确认”。
3. 进入详情页，确认最终图为 `5/5`、目标标题和自动定价已生成。
4. 点击“确认写回妙手”。
5. 在 `/write-records` 查看同一 canonical 妙手详情 ID 的写回记录。

## 用户可见入口

- Web（工作台）：`http://127.0.0.1:3000`（loopback only；保持 `ALLOW_LAN=false`）。
- 扩展：Chrome / Edge 加载 `apps/extension/dist`。
- 扩展调用本机摄取 API 时使用 `EXTENSION_TOKEN`（Bearer auth，服务端只存 SHA-256 摘要）。

## 备份范围

同一时间点的两样东西必须一起备份，否则重放会不一致：

1. PostgreSQL 数据库（任务、租约、approval 快照、外部远端 ID）。
2. `ASSET_ROOT`（默认 `./data/assets`，原始图与生成图）。

`data/runtime/processes.json` 不属于业务事实来源，可以从启动记录重建，不要纳入备份。

## 当前阶段的明确边界

- 默认 mock：妙手、Canvas、LLM、汇率都走 `EXTERNAL_ADAPTER_MODE=mock`。
- full-live 必须显式 ACK：`LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp`。
- 不开放 LAN：Web 与摄取 API 只监听 loopback。
- 不自动发布：妙手最终动作仅编辑同一 canonical 公共采集箱商品，不发布 TikTok。
- 不自动重试外部不确定结果：UI 仅人工对账，参见 `recovery.md`。

## 排障速查

| 现象 | 可能原因 | 下一步 |
|---|---|---|
| `start` 报 `local production start is already in progress` | 上一次 `start` 没正常收尾，或另一个 start 正在跑 | 等待另一个 start 结束；确认无残留后删 `data/runtime/start.lock` |
| `start` 报 `startup recovery metadata requires manual cleanup` | 上一轮启动失败但有进程残留 | 阅读 `data/runtime/processes.json` 的 `records`，按 PID 手工确认进程组已清退后删除该文件 |
| `start` 报 secret leak | 子进程日志命中敏感字段 | 不会启动成功；已自动停止并 redact 日志；查 `.env` 是否被 echo 进子进程日志 |
| `status` 报 `worker: not_ready` | Worker 还没完成首个 DB 周期 | 等待数秒重试；如持续，检查 `data/runtime/worker.log` |
| Web 502/连不上 | 还没到 2xx 就查 status | `status` 是稳态查询；启动期间请等待 `start` 自然返回 |

## 相关文档

- [本地开发与 MVP 验收](../development/local-setup.md)
- [故障恢复](./recovery.md)
- [安全运行基线](./security.md)
- [无 Canvas 图片生成操作指南](./headless-image-generation.md)
