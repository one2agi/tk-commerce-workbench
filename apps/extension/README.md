# TK Commerce Workbench Collector

Chrome MV3 浏览器扩展，用于在 [1688.com](https://1688.com) 商品列表/详情页**勾选商品 → 提交到本地工作区的 ingest API**。

## 它做什么

扩展本身不做商品渲染、不做数据抓取核心（那些在 web/worker 服务端）。
扩展做三件事：

1. **在 1688 商品列表/详情页注入选择 overlay**（`content/scan-store.ts`、`store-overlay.ts`）
2. **接收 popup 的提交消息**，转给 background service worker（`background/index.ts`）
3. **用 Bearer token 把批次 POST 到 `http://127.0.0.1:3000/api/v1/ingest-links`**（`background/submit-selected.ts`）

提交失败（网络 / 4xx / 5xx）会把整批**进 PAUSE 状态保留到 `chrome.storage.local`**，下次打开再尝试——**绝不静默丢弃**。

## 流程图

```
1688 商品页                扩展                            本地后端
─────────                ─────                            ─────────
[勾选商品]   ──onClick──▶ content/scan-store            ┐
                          (DOM overlay)                  │
                                                          │
[点 popup 提交] ──msg──▶ background/service_worker      │
                          ↳ submit-selected              │
                          ↳ POST /api/v1/ingest-links ──▶ web app
                          ↳ Bearer <EXT_TOKEN>         (loopback + SHA-256
                          ↳ { version, batchId, items }   digest 比较)
                          ↳ 失败 → pausedSubmission ◀─▶  chrome.storage.local
                                                          │
[打开 popup]    ────────────▶ 显示"打开 1688 商品列表     │
                                页即可勾选采集"
                                                          ┘
```

## 开发/构建

```bash
# 安装
pnpm install

# 单元测试（23 用例，覆盖 scan-store / submit-selected / token-settings / normalize-1688-url / selected-ingest-flow / extension-build）
pnpm --filter @tk/extension test

# 类型检查 + lint
pnpm --filter @tk/extension typecheck
pnpm --filter @tk/extension lint

# 开发模式（vite dev server，含 HMR）
pnpm --filter @tk/extension dev

# 生产构建（产物在 apps/extension/dist/，会被 Chrome 加载）
pnpm --filter @tk/extension build
```

## 装到 Chrome（一次性）

1. 跑 `pnpm --filter @tk/extension build` 生成 `dist/`
2. 打开 `chrome://extensions/`
3. 右上角打开 **开发者模式**
4. 点 **加载已解压的扩展程序**
5. 选择 `apps/extension/dist/` 目录（必须是 `dist/`，不是 `src/` —— Chrome 不读 TS，只读 build 产物）
6. 记住扩展 ID（用于后面排查问题）

## 配令牌（一次性 + 改 token 时）

服务端验证 token 是 **SHA-256 + timingSafeEqual**，所以两端必须同值。token 不进 commit、不进 git history。

**服务端**（`apps/web/.env`，没有就拷 `.env.example`）：

```bash
# 在仓库根目录
echo 'EXTENSION_TOKEN='"$(openssl rand -hex 32)" >> apps/web/.env
# 或：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**扩展端**：

1. 点 Chrome 工具栏扩展图标 → 「**连接设置**」按钮
2. 打开 options 页（标题「TK 采集设置」）
3. 在「访问令牌」框里**粘贴同一个 token** → 点「保存」
4. 状态栏显示「已保存」即完成

**两侧 token 必须一致**，否则提交会回 401 unauthorized。

## 使用（每天）

1. 启动本地 runtime：`node scripts/local-production-runtime.mjs start`
2. 打开 https://1688.com 商品列表/详情页
3. 扩展自动注入勾选 overlay
4. 选中要的商品
5. 点 Chrome 工具栏扩展图标 → 点提交
6. 等几秒，POPUP/页面会显示「submitted」或「paused」
7. 进 `http://127.0.0.1:3000/products` 看采集结果 → 进 `/tasks` 看后续任务

> 如果 popup 显示「paused」，多半是：① token 错了；② web runtime 没起；③ 是 Browser 加载的 page 不是真 loopback（拒绝非 loopback 是故意做的）。

## 关键 URL 与端口

| 用途 | URL | 来源 |
|---|---|---|
| 提交 API | `http://127.0.0.1:3000/api/v1/ingest-links` | hardcoded in `src/background/index.ts` `apiBase` |
| Web UI | `http://127.0.0.1:3000/` | web runtime |
| 任务中心 | `http://127.0.0.1:3000/tasks` | web runtime |

修改 API 端口 = 改 `apiBase` 然后重 build。

## Host permissions（manifest 里有）

- `https://1688.com/*` + `https://*.1688.com/*`：选中 overlay 的注入目标
- `http://127.0.0.1/*` + `http://localhost/*`：POST ingest API
- `storage`：存 token + 失败时的暂停批次

**安全边界**：
- Token 从不写入页面 DOM/log，**只在 `chrome.storage.local`** 里以 raw 形式存在
- 服务端只存 SHA-256 digest（`apps/web/src/server/auth/extension-token.ts`），永远不会反算
- `rejectNonLoopback` 中间件拒绝非 loopback IP 的 ingest 请求（外网不能直接打）

## 文件结构

```
src/
├── background/        # Service worker：接收来自 popup 的提交消息 + paused-batch 读
│   ├── index.ts       #   注册 chrome.runtime.onMessage
│   └── submit-selected.ts  # 实际 POST /api/v1/ingest-links + paused 队列
├── content/           # 1688 页面内注入
│   ├── index.ts       #   入口
│   ├── scan-store.ts  #   扫描商品列表/详情
│   └── store-overlay.ts # 勾选 overlay UI
├── options/           # 扩展 options 页（chrome://extensions → 详细信息 → 扩展程序选项）
│   ├── index.ts       #   入口 + 表单监听
│   └── token-settings.ts  # chrome.storage.local 的 token 读写
├── popup/             # 工具栏弹出小窗
│   └── index.ts       # 「连接设置」按钮 → chrome.runtime.openOptionsPage()
└── shared/
    └── normalize-1688-url.ts  # 1688 商品 URL 标准化
```

## 调试技巧

**Content script 不生效**：
- Chrome DevTools → Sources → top 切换到 1688 的 frame
- Console 里打印 `chrome.storage.local.get("extensionToken")` 看 token 是否注入
- 1688 是 SPA，路由切换后 overlay 会丢失；**F5 刷新当前页**即可

**Background 日志**：
- `chrome://extensions/` → 找到 TK Collector → 点「**Service Worker**」(inspect views: service worker)
- Console 里看 submit 链路日志

**关键测试**：
```bash
pnpm --filter @tk/extension exec vitest run --pool=vmForks \
  src/background/submit-selected.test.ts \
  src/content/scan-store.test.ts \
  src/options/token-settings.test.ts \
  src/selected-ingest-flow.test.ts
```

## 已知边界 / 故意不做

- **不支持 Firefox / Safari**（manifest_version: 3 假设 Chrome MV3 语义）
- **不抓商品图/标题/价格等业务字段**——那由 worker 服务端跑 miaoshou collect 任务，扩展只负责「我想要这个 URL」
- **不在 popup 里展示提交历史**——看历史进 `/tasks`
- **token 只在 popup options 里改**，没有 dev console 端入口（避免误操作泄漏到截图/录屏）
