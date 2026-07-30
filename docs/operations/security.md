# 安全运行基线

- Web、PostgreSQL 和扩展摄取 API 默认只监听 loopback；保持 `ALLOW_LAN=false`。
- 妙手、Canvas、LLM 密钥只通过环境变量提供。UI 只能显示“已配置/未配置”，日志、数据库、fixture 和截图不得包含明文。
- 扩展 Token 使用随机长值并定期轮换；不要复用妙手或 Canvas 密钥。
- `EXTERNAL_ADAPTER_MODE=mock` 是开发和自动化测试默认值。测试进程会拒绝 live 模式，防止误扣费或误写商品。
- 本地生产 full-live 只能在 `ALLOW_LAN=false` 且 `LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp` 时启动；它用于单机真实 MVP 验收，不得打印 secrets。
- 真实 Canvas 运行受每日额度约束；验收单次运行还需操作者明确批准。妙手最终动作仅编辑同一 canonical 公共采集箱详情。
- 不开放自动认领、TikTok 采集箱编辑或发布 API；若未来增加，必须作为独立版本重新威胁建模和授权。
- 外部图片下载必须校验协议、DNS、重定向、内容类型和体积，并固定已验证地址，避免 SSRF。
- 备份 PostgreSQL 与 `ASSET_ROOT`；备份介质按密钥同等级保护。

提交前运行基础差异检查；发布环境另行安装 `gitleaks` 后执行专用 secret 扫描。后者是发布门禁，不应以简单正则替代：

```bash
git diff --check
gitleaks detect --source . --no-banner --redact
```
