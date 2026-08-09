# 生图模板生产可用性验收记录

日期：2026-08-09  
页面：`http://localhost:3000/templates`  
验收环境：本地 Docker 开发环境，Chrome DevTools MCP AutoConnect，桌面视口

## 结论

`/templates` 已能展示数据库中的真实模板状态，并提供创建、版本操作、高级配置和只生成提示词的安全测试入口。浏览器验收没有执行启用、保存、新建或提示词测试，因此没有改动现有模板，也没有产生 Planner 或图片模型费用。

## 自动化证据

- 生产构建：`pnpm --filter @tk/web build` 通过，`/templates` 为动态服务端路由。
- 类型检查：`pnpm typecheck` 通过（8 个 workspace 项目）。
- 代码规范：`pnpm lint` 通过，零 warning。
- 模板相关单测：7 个文件、26 个测试全部通过。
- 环境权限复测：内容寻址、Next loopback 和设置安全边界共 3 个文件，50 个测试通过、4 个 PostgreSQL 用例按配置跳过。
- 数据库集成：`loadPromptTestContext` 聚焦用例通过，确认读取最新商品事实和最多 6 张就绪本地参考图。
- Playwright 用例已新增到 `e2e/templates.spec.ts`。本机缺少 Playwright 专用 Chromium，未能执行该 runner；同一真实页面流程已由 Chrome DevTools MCP 完成。

完整 `pnpm test` 未正常收尾：`image-generation-template-manager.test.tsx` 在当前 WSL/挂载盘环境中卡在 Vitest worker 启动，fork 和 vmThread 均可复现。运行中出现的 loopback/listen 权限失败在沙箱外单独复测后全部通过；过期的设置页安全文案断言已更新并通过。

## Chrome DevTools 证据

- 页面标题：`生图模板 · TK 商品自动化`。
- 根语言：`zh-CN`。
- 真实状态一致性：模板 API 返回 2 条，页面渲染 2 张模板卡片。
- 主导航包含“生图模板”，创建表单和高级设置均可访问。
- 高级设置中的“测试提示词”明确提示会产生提示词模型费用；未填写商品 ID 时按钮禁用。
- 控制台：展开高级设置后 0 条 error、warning 或 issue。
- 网络：页面文档、CSS、JS、字体和图标请求均为 200。
- 桌面布局：`scrollWidth === clientWidth`，无横向溢出；主内容最大宽度 1120px。
- Lighthouse desktop：Accessibility 100、Best Practices 100、SEO 100、Agentic Browsing 100，52 项通过、0 项失败。
- Performance trace：LCP 1269ms，CLS 0.00；无 CPU 和网络节流。

## 有意未执行的真实操作

- 未启用、恢复或保存任何现有模板。
- 未创建新模板。
- 未调用真实 Planner，也未创建图片任务。
- 未调用图片 Provider。

这些操作会改动业务状态或产生模型费用，当前验收由路由单测、数据库集成测试和只读浏览器检查覆盖。
