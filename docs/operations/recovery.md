# 故障恢复

## Worker 中断

重新启动 `pnpm --filter @tk/worker start`。任务、租约和外部远端 ID 都在 PostgreSQL 中；Worker 会先对账再继续。不要手工删除 `jobs`、审批快照或远端 ID，否则会失去防重复依据。

## “外部结果未知”

这表示请求可能已经被 Canvas 或妙手接收，但本机没有拿到确定响应。界面只允许人工对账，不提供“安全重试”。先通过任务 ID/canonical 妙手详情核对外部状态；确认未发生副作用后，再由运维人员按审计记录处理。禁止直接重复点击或重置为 queued。

## 妙手重复采集

妙手返回 `skip` 时，不能把新的 skip detail ID 当成商品。系统按 `sourceItemId` 查询已有 `success` 记录并复用 canonical detail；如果暂时查不到，等待重试，不创建第二条商品。

## 素材与数据库

数据库是任务状态事实来源，`ASSET_ROOT` 是原始图和生成图事实来源。恢复时二者必须来自同一备份时间点。临时 staging URL 可失效并重建，但本地素材不可被重跑覆盖。

## 安全回滚边界

代码可回滚，数据库迁移和外部副作用不可凭代码回滚。回滚前暂停 Worker；确认没有 `running`/`reconcile_required` 任务，再恢复兼容版本。任何 Canvas 或妙手不确定写入都先对账。
