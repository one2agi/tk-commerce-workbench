# 本地生产（单人单机）

本目录文档描述在**同一台机器**上把工作台跑成“生产模式”的最小流程：浏览器扩展采集 → 本机 Web/Worker → 外部适配器全部走 mock。它**不**对外暴露服务、不写真实妙手 / Canvas / LLM / 汇率。Live 接入是后续版本的事，本阶段不切。

## 谁应该用

- 单人单机演示 / 联调 / 验收：完整跑通采集 → 选品 → 流水线（mock 收尾）。
- 集成测试与 E2E 在 CI 里跑，不依赖本机服务。

## 前置条件

- Node.js 22（与 `.node-version` 一致）、Corepack、Docker Desktop。
- PostgreSQL 容器 `tk-workbench-postgres`，端口 `127.0.0.1:5432`（见 `docker-compose.yml`）。
- `apps/extension/dist` 已构建（浏览器扩展侧载目录）。
- 本机根目录有真实 `.env`（来自 `scripts/local-production-config.mjs`，权限 `0600`，见下文）。

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
- 写入 `<repo>/.env`（`wx` 创建，权限 `0600`）。
- 创建 `data/runtime/`、`data/assets/` 等目录（权限 `0700`）。
- 生成随机的 `EXTENSION_TOKEN`（如 secrets 文件未提供）。
- 强制 `EXTERNAL_ADAPTER_MODE=mock`、`ALLOW_LAN=false`，不覆盖用户原值。

写入后请手工核对键名、文件权限（`.env` 必须 `0600`、数据目录必须 `0700`），确认 `.env` 与 `data/` 已在 `.gitignore`。**不要**把 secrets 文件内容 `cat` 或 `source` 到 shell；初始化完成后建议 `shred -u /mnt/d/project/TKcaiji/TKskill/env.txt`（或同等安全删除）以免明文留在磁盘上。

## 构建扩展（首次或升级后）

```bash
pnpm --filter @tk/extension build
```

产物在 `apps/extension/dist/`。在 Chrome / Edge 打开 `chrome://extensions` → “加载已解压的扩展程序” → 选择 `apps/extension/dist`。每次重建后扩展会自动重载。

## 启动 / 状态 / 停止

```bash
# 启动（前台执行；命令返回代表 readiness 已通过）
node scripts/local-production-runtime.mjs start

# 查询当前 launchId、worker readiness、PG 健康等（只输出 JSON，不含 secrets）
node scripts/local-production-runtime.mjs status

# 优雅停机（SIGTERM → SIGKILL，全组清退）
node scripts/local-production-runtime.mjs stop
```

启动器做了：

- 校验 `.env` 存在、`EXTERNAL_ADAPTER_MODE=mock`、`ALLOW_LAN=false`、`DATABASE_URL` 已设置、`apps/web/.next/BUILD_ID` 存在。
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

## 用户可见入口

- Web（工作台）：`http://127.0.0.1:3000`（loopback only；保持 `ALLOW_LAN=false`）。
- 扩展：Chrome / Edge 加载 `apps/extension/dist`。
- 扩展调用本机摄取 API 时使用 `EXTENSION_TOKEN`（Bearerauth，服务端只存 SHA-256 摘要）。

## 备份范围

同一时间点的两样东西必须一起备份，否则重放会不一致：

1. PostgreSQL 数据库（任务、租约、approval 快照、外部远端 ID）。
2. `ASSET_ROOT`（默认 `./data/assets`，原始图与生成图）。

`data/runtime/processes.json` 不属于业务事实来源，可以从启动记录重建，不要纳入备份。

## 当前阶段的明确边界

- 仅 mock：妙手、Canvas、LLM、汇率都走 `EXTERNAL_ADAPTER_MODE=mock`。
- 不切 live：本阶段不接真实外部写入，不消耗额度，不产生费用。
- 不开放 LAN：Web 与摄取 API 只监听 loopback。
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