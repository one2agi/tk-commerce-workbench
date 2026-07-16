# 本地开发与 MVP 验收

## 快速启动

前置条件：Node.js 22、Docker 和 Corepack。复制 `.env.example` 为本机环境配置，至少填写两个本地 PostgreSQL URL、`LOCAL_OPERATOR_ID` 和随机的 `EXTENSION_TOKEN`；开发阶段保持 `ALLOW_LAN=false`、`EXTERNAL_ADAPTER_MODE=mock`。当前 `LOCAL_OPERATOR_ID` 实际作为固定本地操作员的 `handle` 使用，推荐值为 `local-operator`。

```bash
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
set -a
source .env
set +a
docker compose up -d --wait postgres
pnpm db:migrate
pnpm dev
```

Web 只监听 `127.0.0.1`。素材默认永久保存在 `ASSET_ROOT`，不要把 `data/` 加入 Git。一次性验证全新环境使用：

```bash
bash scripts/verify-fresh-install.sh
```

该脚本创建独立的临时 PostgreSQL 容器和随机宿主端口，不会删除已有开发数据库；退出时自动停止临时容器。

## 17 项 MVP 验收记录

除第 1 项外，先按上文导出测试环境变量并启动 PostgreSQL，再执行 `pnpm build` 与 `pnpm exec playwright install --with-deps chromium`。下表命令是可复跑的验收证据；外部写操作全部使用 Mock。Gate G4 已使用全新依赖安装与临时数据库完整执行，以下 17 项均通过。

| # | 验收结果 | 精确命令或测试 |
|---|---|---|
| 1 | PASS | `bash scripts/verify-fresh-install.sh`（临时 PostgreSQL 健康并完成迁移；Web 生产包返回 HTTP 200；Worker 建立轮询连接、持续运行并可由 SIGTERM 安全退出；Chromium 实际侧载扩展且启动 MV3 service worker） |
| 2 | PASS | `pnpm --filter @tk/extension exec vitest run src/selected-ingest-flow.test.ts && pnpm exec playwright test e2e/collection-to-product-pool.spec.ts` |
| 3 | PASS | `pnpm exec playwright test e2e/collection-to-product-pool.spec.ts` |
| 4 | PASS | `pnpm exec playwright test e2e/collection-to-product-pool.spec.ts -g "sample 1688 URL converges duplicate collection"` |
| 5 | PASS | `pnpm exec playwright test e2e/collection-to-product-pool.spec.ts && pnpm exec playwright test e2e/full-mocked-flow.spec.ts -g "勾选采集到当前版本审批"` |
| 6 | PASS | `pnpm exec playwright test e2e/browser-workbench.spec.ts && pnpm --filter @tk/db exec vitest run --config vitest.integration.config.ts -t "concurrent createOrReuseAndEnqueue|records every repeated human start" && pnpm exec playwright test e2e/full-mocked-flow.spec.ts -g "勾选采集到当前版本审批"` |
| 7 | PASS | `pnpm --filter @tk/web exec vitest run src/app/api/v1/api.integration.test.ts -t "rerun preserves the original Chinese revision"`（真实 PostgreSQL 重跑 API；前后快照断言原始 `source_title`/`source_payload`、原素材 `sha256`/`local_path`/所属修订不变，同时创建新修订、素材引用和下游 job；外部适配器零调用） |
| 8 | PASS | `pnpm --filter @tk/adapters exec vitest run src/llm/openai-compatible-adapter.test.ts && pnpm --filter @tk/domain exec vitest run src/listing/generate-listing.test.ts` |
| 9 | PASS | `pnpm --filter @tk/worker exec vitest run src/handlers/pipeline-handlers.test.ts -t "pauses with needs_input when (weightKg|sourceCostCny|exchangeRate) is absent" && pnpm --filter @tk/worker exec vitest run src/handlers/pipeline-handlers.test.ts -t "persists a reproducible ready price" && pnpm --filter @tk/db exec vitest run --config vitest.integration.config.ts -t "exchange rate snapshots"` |
| 10 | PASS | `pnpm --filter @tk/adapters exec vitest run src/canvas/canvas-adapter.test.ts && pnpm --filter @tk/worker exec vitest run src/handlers/pipeline-handlers.test.ts -t "capacity-aware ordered image selection|locally archived Canvas outputs"` |
| 11 | PASS | `pnpm exec playwright test e2e/worker-recovery.spec.ts && pnpm --filter @tk/worker exec vitest run --config vitest.integration.config.ts src/runtime/recovery.pg.test.ts` |
| 12 | PASS | `pnpm exec playwright test e2e/full-mocked-flow.spec.ts -g "勾选采集到当前版本审批" && pnpm --filter @tk/db exec vitest run --config vitest.integration.config.ts -t "transactionally invalidates"` |
| 13 | PASS | `pnpm exec playwright test e2e/full-mocked-flow.spec.ts -g "勾选采集到当前版本审批"` |
| 14 | PASS | `pnpm --filter @tk/web exec vitest run src/app/product-safety.test.tsx src/components/products/product-workbench.scan.test.ts` |
| 15 | PASS | `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration && pnpm test:e2e` |
| 16 | PASS | `pnpm exec playwright test e2e/browser-workbench.spec.ts && pnpm exec playwright test e2e/ui-context.spec.ts` |
| 17 | PASS | `pnpm exec playwright test e2e/browser-workbench.spec.ts && pnpm --filter @tk/web exec vitest run src/components/products/product-workbench.projection.test.ts src/components/products/product-workbench.scan.test.ts` |

真实妙手仅允许只读合同检查；真实 Canvas 生图必须由操作者单独批准，且一次验收最多执行一轮。本表没有声称执行这两类外部写入。
