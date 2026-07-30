# Workbench Experience Repair Verification

Date: 2026-07-22

## MVP Acceptance Criteria

1. 1688 单品或搜索页中被选中的商品进入本地商品处理台；未勾选商品不采集。
2. 商品处理台用业务状态展示：全部、待处理、自动处理中、待确认、需要人工处理、已完成。
3. 点击开始处理后，系统自动完成标题清洗、定价、素材处理和 Canvas 生图；人工不需要逐项推进后台节点。
4. Canvas 运行本地 `http://127.0.0.1:8123` 的 `TK工作流`，最多输入 9 张图，期望输出 5 张可用图。
5. 点击商品图片、查看或待确认动作进入 `/products/{productId}` 商品详情 / 图片确认页。
6. 图片确认页展示最终图片、源/目标商品内容、SKU/价格/属性事实和检查结果。
7. 用户明确点击“确认写回妙手”后，系统编辑同一条 canonical 妙手公共采集箱商品。
8. 写入记录页展示 `miaoshou_syncs` 中的同步 ID、审批快照、状态、妙手详情 ID、最近对账和安全错误信息。
9. 设置页只展示真实工作区默认值、运行边界和系统诊断入口；任务中心不在主导航，Canvas 不提供前端参考素材或视觉参数配置。
10. 全流程不暴露 TikTok 发布、TikTok 认领或账号登录能力。

## Fixed Samples

- Single A: `https://detail.1688.com/offer/1013001591920.html?spm=a26352.13672862.offerlist.74.64241e62GBUfEO&cosite=-&tracelog=p4p&_p_isad=1&clickid=d609322de4c446eb9c7ad5f32c7264ef&sessionid=79d7417242becda81904b0b6debcf258`
- Single B: `https://detail.1688.com/offer/892408514788.html`
- Batch: `https://s.1688.com/selloffer/offer_search.htm?keywords=%BC%D2%BE%DF%D7%B0%CA%CE%B0%DA%BC%FE&spm=a26352.13672862.searchbox.0`

## Automated Checks

- `pnpm --filter @tk/web test -- product-row-view.test.ts product-workbench.state.test.ts product-workbench.projection.test.ts 'products/[productId]/page.test.tsx' final-review.test.tsx write-records/page.test.tsx batch-actions/route.test.ts product-workbench.command.test.ts product-safety.test.tsx`: PASS, 9 files / 64 tests.
- `pnpm --filter @tk/web test -- --pool=threads settings-workspace.test.tsx sections.test.tsx`: PASS, 2 files / 18 tests.
- `pnpm --filter @tk/web typecheck`: PASS.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS.
- `DATABASE_URL=... TEST_DATABASE_URL=... LOCAL_OPERATOR_ID=op_browser EXTENSION_TOKEN=e2e-local-extension-token ALLOW_LAN=false EXTERNAL_ADAPTER_MODE=mock ASSET_ROOT=./data/e2e-assets pnpm exec playwright test e2e/browser-workbench.spec.ts e2e/workbench-fixed-samples.spec.ts --reporter=line`: PASS, 3 tests.

## Remaining Verification To Run Locally

- Manual live acceptance with the real browser extension, local Canvas 8123, and Miaoshou account.

The automated E2E gate uses the local test database `tk_workbench_test` and mock adapter mode. It validates browser UI contracts and fixed sample guardrails; it does not spend Canvas or Miaoshou quota.

## Manual Live Acceptance

- 1688 selected product reaches product workbench.
- User clicks Start Processing.
- Canvas 8123 `TK工作流` returns 5 usable images.
- Product detail / image confirmation page shows generated images and cleaned title.
- User clicks Confirm Write Back To Miaoshou.
- The same canonical Miaoshou public collect-box item is edited.

## Known Non-Goals

- No TikTok publish.
- No TikTok claim.
- No SaaS login.
- No front-end Canvas reference-material or visual-parameter configuration.
