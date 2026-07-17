# 本地生产环境初始化设计

## 目标

在当前单用户 Windows/WSL 机器上初始化可持续运行的 TK 商品工作台。首阶段只验证本地生产链路，不执行任何真实妙手、Canvas、LLM 或汇率外部写入，也不产生生图费用。

## 运行方式

采用仓库本地运行：PostgreSQL 由现有 Docker Compose 管理，Web 与 Worker 使用仓库锁定的 Node.js 22 和 pnpm 9.15.9 构建后后台运行。运行日志和 PID 文件放入 Git 忽略的 `data/runtime`，素材永久保存到 `data/assets`。

## 环境与密钥

- 创建 Git 忽略的项目 `.env`，不创建可提交的真实密钥文件。
- 数据库使用 loopback 地址，Web、扩展摄取 API 与 PostgreSQL均不监听局域网。
- 为浏览器扩展生成独立随机 Token，不复用妙手或 Canvas 密钥。
- 从 `TKskill/env.txt` 读取妙手 App ID 与 App Secret，仅写入项目 `.env`，命令输出、日志和最终报告不得回显值。
- Canvas 地址预置为 `https://canvas-n8n.ai2hook.com`；本阶段不要求 Canvas API Key、LLM 或汇率 provider 可用。
- `EXTERNAL_ADAPTER_MODE=mock` 固定为首阶段安全边界。真实凭据即使已配置，也不得触发真实外部请求。

## 初始化流程

1. 校验 Node.js、pnpm、Docker 与当前 `main` 工作区。
2. 创建 `.env`、`data/assets` 和 `data/runtime`，设置本地权限并确认均被 Git 忽略。
3. 启动并健康检查 PostgreSQL，执行数据库迁移，确保固定本地操作员存在。
4. 使用冻结依赖完成生产构建，生成 Web 与浏览器扩展产物。
5. 后台启动 Web 与 Worker，将 PID 和脱敏日志写入 `data/runtime`。
6. 验证 Web HTTP 200、Worker 已连接 PostgreSQL、扩展 `dist/manifest.json` 与入口文件存在。
7. 输出浏览器扩展侧载目录和停止/重启命令，不执行真实商品采集或处理。

## 错误与回滚

- 任一步失败立即停止本次新启动的 Web/Worker；PostgreSQL 数据卷和 `data/assets` 不删除。
- 已存在的 `.env` 不覆盖；若发现冲突，先备份并停止初始化。
- PID 文件必须与实际进程命令匹配后才能停止进程，防止误杀其他程序。
- 日志中发现凭据、Authorization 或 App Secret 时，初始化判定失败并要求轮换密钥。

## 验收标准

- 当前分支为 `main`，Git 仅保留用户已有的未跟踪文件。
- PostgreSQL 健康，迁移成功；Web 返回 HTTP 200；Worker 持续轮询数据库。
- 扩展生产包可加载，素材与运行目录持久存在。
- 设置状态明确显示外部适配器处于 Mock 模式。
- 没有真实妙手、Canvas、LLM 或汇率外部写入，没有 Canvas 费用。
- 提供后续切换 live 的独立灰度步骤，但本次不执行。
