# TK Commerce Workbench Collector

Chrome MV3 浏览器扩展，用于把**当前打开的 1688 商品详情页一键采集到本地工作台**。

## 它做什么

扩展做三件事：

1. **弹窗只识别当前活动标签中的标准 1688 商品详情页**
2. **优先读取 1688 页面商品上下文，再用限定商品区域的 DOM 兜底**，提取标题、价格、库存、实际 SKU、图片、属性、重量和包装尺寸（`content/page-context-bridge.ts`、`detail-parser.ts`）
3. **用 Bearer token 把 V3 采集结果 POST 到 `http://127.0.0.1:3005/api/v1/local-captures`**（端口与本地工作台 `TK_WEB_PORT` 保持一致，当前为 3005）

详情连续稳定 2 秒才会提交，单商品最长等待 45 秒。扩展不创建或关闭商品标签页；SVG、页面图标、登录页、店铺标题和伪造 SKU 不会作为完整采集入库。

## 流程图

```
1688 商品页                扩展                            本地后端
─────────                ─────                            ─────────
[点扩展图标]   ────────▶ popup 检查当前活动标签          │
[一键采集]     ──msg──▶ background/service_worker       │
                          ↳ 读取当前详情页                │
                          ↳ MAIN-world 商品上下文桥      │
                          ↳ 稳定等待 + detail-parser     │
                          ↳ POST /api/v1/local-captures ─▶ web app
                          ↳ Bearer <EXT_TOKEN>         (loopback + SHA-256
                          ↳ { version, batchId, items }   digest 比较)
                          ↳ 同批次重试复用幂等键          │
                                                          ┘
```

## 开发/构建

```bash
# 安装
pnpm install

# 单元测试
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
2. 打开一个标准的 `https://detail.1688.com/offer/<商品ID>.html`
3. 点击工具栏里的扩展图标
4. 点击「一键采集到工作台」
5. 核对弹窗里的价格、库存、SKU、主图、详情图和缺失项；部分成功时点击「重新采集」
6. 点击「打开工作台商品」查看入库结果

> 如果 popup 显示「paused」，多半是：① token 错了；② web runtime 没起；③ 是 Browser 加载的 page 不是真 loopback（拒绝非 loopback 是故意做的）。

## 关键 URL 与端口
 
| 用途 | URL | 来源 |
|---|---|---|
| 提交 API | `http://127.0.0.1:3005/api/v1/local-captures` | hardcoded in `src/background/index.ts` `apiBase`（根据宿主机 `TK_WEB_PORT` 配置，当前为 3005） |
| Web UI | `http://127.0.0.1:3005/` | web runtime |
| 任务中心 | `http://127.0.0.1:3005/tasks` | web runtime |

修改 API 端口 = 改 `apiBase` 然后重 build。

## Host permissions（manifest 里有）

- `https://detail.1688.com/offer/*`：当前详情页解析目标
- `http://127.0.0.1/*` + `http://localhost/*`：POST ingest API
- `storage`：存 token + 失败时的暂停批次
- `tabs`：读取当前活动标签，不创建或关闭商品页
- MAIN-world bridge 只返回采集契约允许的商品字段，不导出完整页面上下文或登录信息

**安全边界**：
- Token 从不写入页面 DOM/log，**只在 `chrome.storage.local`** 里以 raw 形式存在
- 服务端只存 SHA-256 digest（`apps/web/src/server/auth/extension-token.ts`），永远不会反算
- `rejectNonLoopback` 中间件拒绝非 loopback IP 的 ingest 请求（外网不能直接打）

## 文件结构

```
src/
├── background/        # Service worker：接收来自 popup 的提交消息 + paused-batch 读
│   ├── index.ts       #   注册 chrome.runtime.onMessage
│   ├── capture-queue.ts    # 串行详情采集队列
│   ├── chrome-capture-tab-port.ts # Chrome tabs 适配
│   └── submit-selected.ts  # 实际 POST /api/v1/local-captures + paused 队列
├── content/           # 1688 页面内注入
│   ├── index.ts       #   入口
│   ├── page-context-bridge.ts # MAIN world 白名单商品上下文
│   ├── detail-parser.ts # 稳定等待、详情正文/图片、属性、结构化 SKU 解析
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
- Edge/Chrome DevTools → Sources → top 切换到 1688 的 frame
- Console 里打印 `chrome.storage.local.get("extensionToken")` 看 token 是否注入
- 1688 是动态页面；字段仍在加载时，扩展会等待稳定后再提交
- 本次升级后必须在 `edge://extensions/` 或 `chrome://extensions/` 对已加载扩展点击一次「重新加载」；旧 V1/V2 提交会收到 `extension_upgrade_required`

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
- **不使用属性笛卡尔积猜测 SKU**——只能提交页面提供的实际 SKU 映射
- **不绕过登录、验证码或风控**——只读取用户浏览器能正常打开的页面
- **不在 popup 里展示提交历史**——看历史进 `/tasks`
- **token 只在 popup options 里改**，没有 dev console 端入口（避免误操作泄漏到截图/录屏）
