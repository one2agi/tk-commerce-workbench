# Image Template Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/templates` a production-usable desktop workflow whose visible state matches persisted templates and whose prompt test uses the applied UI-managed Headless runtime configuration.

**Architecture:** Keep the page server-rendered and dynamic, using the existing template service as the single list source. Keep template mutations in the current API routes and refresh the Server Component after success. Add a narrowly scoped runtime Planner loader and prompt-test context reader so the test route uses applied settings and real product evidence without creating image-generation jobs.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Zod, PostgreSQL repositories, Vitest, Testing Library, Playwright, Chrome DevTools MCP.

## Global Constraints

- Desktop only; do not add a mobile-specific redesign.
- Do not add a category-management subsystem or new database tables.
- Do not delete or modify the user's existing template records during implementation or verification.
- Prompt testing may call the configured Planner but must never call the image provider or create image-generation jobs.
- Preserve the user's unrelated edits in `apps/web/src/components/products/product-workbench.tsx` and `e2e/browser-workbench.spec.ts`.
- Use the existing versioned draft/active/archived template lifecycle.
- UI copy must be concise Chinese and errors must state the next action.

---

### Task 1: Render persisted templates and expose the page

**Files:**
- Create: `apps/web/src/app/templates/page.test.tsx`
- Modify: `apps/web/src/app/templates/page.tsx`
- Create: `apps/web/src/components/navigation/sidebar.test.tsx`
- Modify: `apps/web/src/components/navigation/sidebar.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: `getServerServices().imageGenerationTemplates.list(): Promise<{ items: ImageGenerationTemplateViewV1[] }>`
- Produces: `renderTemplatesPage(data: { items: ImageGenerationTemplateViewV1[] }): ReactElement`

- [ ] **Step 1: Write the failing page and navigation tests**

```tsx
it("renders persisted templates instead of the empty state", () => {
  const html = renderToStaticMarkup(renderTemplatesPage({ items: [activeTemplate] }));
  expect(html).toContain("女帽主图");
  expect(html).not.toContain("暂无模板");
});

it("links to the image template workspace", () => {
  render(<Sidebar />);
  expect(screen.getByRole("link", { name: "生图模板" })).toHaveAttribute("href", "/templates");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/app/templates/page.test.tsx src/components/navigation/sidebar.test.tsx`

Expected: FAIL because `renderTemplatesPage` and the navigation entry do not exist.

- [ ] **Step 3: Implement server-side loading and navigation**

```tsx
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "生图模板 · TK 商品自动化",
  description: "创建、测试并启用 Headless 生图模板。"
};

export function renderTemplatesPage(data: { items: ImageGenerationTemplateViewV1[] }) {
  return <ImageGenerationTemplateManager items={data.items} />;
}

export default async function TemplatesPage() {
  return renderTemplatesPage(await (await getServerServices()).imageGenerationTemplates.list());
}
```

Add `{ href: "/templates", label: "生图模板", ariaLabel: "生图模板" }` to the sidebar and change the root document language to `zh-CN`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/app/templates/page.test.tsx src/components/navigation/sidebar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/templates/page.tsx apps/web/src/app/templates/page.test.tsx apps/web/src/components/navigation/sidebar.tsx apps/web/src/components/navigation/sidebar.test.tsx apps/web/src/app/layout.tsx
git commit -m "fix(templates): render persisted template state"
```

### Task 2: Harden category creation and the empty state

**Files:**
- Modify: `apps/web/src/server/services/image-generation-template-service.ts`
- Modify: `apps/web/src/server/services/image-generation-template-service.test.ts`
- Modify: `apps/web/src/app/api/v1/image-generation-templates/route.ts`
- Modify: `apps/web/src/app/api/v1/image-generation-templates/route.test.ts`
- Modify: `apps/web/src/components/templates/image-generation-template-manager.tsx`
- Modify: `apps/web/src/components/templates/image-generation-template-manager.test.tsx`

**Interfaces:**
- Produces: `CategoryKeySchema` with stable ASCII segment validation.
- Produces: service error `category_key_exists` and API response `{ error: "category_key_exists" }` with status `409`.

- [ ] **Step 1: Write failing validation, duplicate, helper-text, and empty-state tests**

```ts
it("rejects category keys that cannot be matched reliably", async () => {
  const response = await handler(jsonRequest({ name: "测试", categoryKey: "随便 写", recipe: minimalRecipe }));
  expect(response.status).toBe(400);
});

it("returns a conflict for a duplicate category key", async () => {
  await handler(jsonRequest({ name: "A", categoryKey: "women.hat", recipe: minimalRecipe }));
  const response = await handler(jsonRequest({ name: "B", categoryKey: "women.hat", recipe: minimalRecipe }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "category_key_exists" });
});
```

```tsx
expect(screen.getByText(/创建并启用后/)).toBeVisible();
expect(screen.getByText(/women\.hat/)).toBeVisible();
expect(screen.getByRole("option", { name: "women.hat" })).toBeInTheDocument();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/server/services/image-generation-template-service.test.ts src/app/api/v1/image-generation-templates/route.test.ts src/components/templates/image-generation-template-manager.test.tsx`

Expected: FAIL on missing validation, conflict mapping, datalist, and explanatory empty state.

- [ ] **Step 3: Implement minimal backend validation**

```ts
export const CategoryKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "categoryKey must use lowercase letters, numbers, dots, underscores, or hyphens");
```

Before creating a template, call `getTemplateByCategoryKey`; throw `category_key_exists` when it returns a template. Map that error to HTTP 409 in the route.

- [ ] **Step 4: Implement minimal desktop UI hardening**

Add a page heading, a `datalist` containing unique existing category keys, `pattern`, `aria-describedby`, concise helper text, a useful empty-state sentence, and error-code-to-Chinese-message mapping. Preserve form values on failed creation and sort items by active, draft, archived.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/server/services/image-generation-template-service.test.ts src/app/api/v1/image-generation-templates/route.test.ts src/components/templates/image-generation-template-manager.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/services/image-generation-template-service.ts apps/web/src/server/services/image-generation-template-service.test.ts apps/web/src/app/api/v1/image-generation-templates/route.ts apps/web/src/app/api/v1/image-generation-templates/route.test.ts apps/web/src/components/templates/image-generation-template-manager.tsx apps/web/src/components/templates/image-generation-template-manager.test.tsx
git commit -m "fix(templates): validate template categories"
```

### Task 3: Load the applied runtime Planner and real prompt-test context

**Files:**
- Modify: `apps/web/src/server/composition.ts`
- Create: `apps/web/src/server/image-prompt-test-runtime.test.ts`
- Modify: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`

**Interfaces:**
- Produces: `ImageGenerationRepository.loadPromptTestContext(productId): Promise<{ productFacts: Record<string, unknown>; references: ResolvedImageReferenceV1[] } | null>`.
- Produces: `ServerServices.loadImagePromptPlanner(context: LiveCommandContext): Promise<ImagePromptPlannerPort>`.

- [ ] **Step 1: Write failing repository and runtime-loader tests**

```ts
it("loads the latest product facts and ready local image references", async () => {
  const context = await repository.loadPromptTestContext(productId);
  expect(context?.productFacts).toMatchObject({ title: "Canonical", category: "饰品 > 手表" });
  expect(context?.references[0]).toMatchObject({ assetId: expect.any(String), extension: "jpg" });
});
```

```ts
it("constructs the planner from the applied UI-managed configuration", async () => {
  const planner = await services.loadImagePromptPlanner({ commandId: "prompt-test:tpl:v1", idempotencyKey: idempotencyKey("prompt-test") });
  expect(createAdapterBundle).toHaveBeenCalledWith(expect.objectContaining({
    externalAdapterMode: "live",
    imageGenerationPath: "headless",
    imagePlannerModel: "planner-from-ui"
  }), expect.objectContaining({ commandId: "prompt-test:tpl:v1" }));
  expect(planner).toBe(adapterBundle.imagePlanner);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/server/image-prompt-test-runtime.test.ts`

Run: `pnpm --filter @tk/db test:integration`

Expected: FAIL because the two interfaces do not exist.

- [ ] **Step 3: Implement the context query**

Use the latest product revision. Build `productFacts` from its title, category and attributes, and return at most six ready local PNG/JPG/JPEG assets ordered with main images first. Return `null` for an unknown product.

- [ ] **Step 4: Implement the runtime Planner loader**

Preserve the full bootstrap `AppConfig` inside web composition. On every prompt-test request, load `RuntimeConfigurationRepository.loadAppliedCandidate()`, decrypt its envelope with the existing codec, resolve it through `resolveRuntimeAppConfig`, and call `createAdapterBundle({ ...resolved, processKind: "app" }, context).imagePlanner`. If an applied candidate exists but cannot be decrypted or is incomplete, throw `runtime_configuration_unavailable`; never fall back to mock.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same web and DB integration commands from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/composition.ts apps/web/src/server/image-prompt-test-runtime.test.ts packages/db/src/repositories/image-generation-repository.ts packages/db/src/integration/repositories.integration.test.ts
git commit -m "fix(templates): use applied planner runtime"
```

### Task 4: Make prompt testing representative and inspectable

**Files:**
- Modify: `apps/web/src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.ts`
- Modify: `apps/web/src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.test.ts`
- Modify: `apps/web/src/components/templates/image-generation-template-manager.tsx`
- Modify: `apps/web/src/components/templates/image-generation-template-manager.test.tsx`

**Interfaces:**
- Route dependency `loadPlanner(context)` returns `ImagePromptPlannerPort`.
- Route dependency `loadProductContext(productId)` returns the real product facts and references or `null`.
- Successful response remains `{ prompts: PlannedImagePromptV1[] }`.

- [ ] **Step 1: Write failing route behavior tests**

```ts
it("plans with real product facts and references without enqueuing image work", async () => {
  const response = await handler(promptRequest, params);
  expect(response.status).toBe(200);
  expect(fakePlanner.calls[0]?.input.productFacts).toMatchObject({ title: "真实商品" });
  expect(fakePlanner.calls[0]?.input.references).toHaveLength(2);
  expect(jobRepository.enqueueCalls).toHaveLength(0);
});

it("returns 404 when the sample product does not exist", async () => {
  expect((await missingProductHandler(promptRequest, params)).status).toBe(404);
});
```

- [ ] **Step 2: Write the failing UI result test**

```tsx
await user.click(screen.getByRole("button", { name: "测试提示词" }));
expect(await screen.findByText("A clean product hero shot")).toBeVisible();
expect(screen.getByText(/会产生提示词模型费用/)).toBeVisible();
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts 'src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.test.ts' src/components/templates/image-generation-template-manager.test.tsx`

Expected: FAIL because the route uses `{ productId }`, empty references and the UI hides returned prompt text.

- [ ] **Step 4: Implement the route and UI result**

Create one idempotency key per request, use it both for the stable adapter command context and Planner input, load the real product context, and map known configuration/upstream failures to safe status codes. Replace `console.log` audit output with the existing injected recorder boundary. Render returned prompts in an ordered, readable result block and state clearly that no image task is created but Planner usage may cost tokens.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same command from Step 3.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'apps/web/src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.ts' 'apps/web/src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.test.ts' apps/web/src/components/templates/image-generation-template-manager.tsx apps/web/src/components/templates/image-generation-template-manager.test.tsx
git commit -m "fix(templates): test prompts with production context"
```

### Task 5: Polish, regress, and verify in the real browser

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Create: `e2e/templates.spec.ts`
- Create: `docs/superpowers/reports/2026-08-09-image-template-production-readiness-verification.md`

**Interfaces:**
- E2E verifies `/templates` against the running local Docker-backed application without editing `e2e/browser-workbench.spec.ts`.

- [ ] **Step 1: Write the failing E2E assertions**

```ts
test("template page exposes persisted state and production guidance", async ({ page }) => {
  await page.goto("/templates");
  await expect(page.getByRole("heading", { level: 1, name: "生图模板" })).toBeVisible();
  await expect(page.getByRole("link", { name: "生图模板" })).toBeVisible();
  await expect(page).toHaveTitle("生图模板 · TK 商品自动化");
});
```

- [ ] **Step 2: Run E2E and verify RED before final CSS**

Run: `pnpm exec playwright test e2e/templates.spec.ts --project=chromium`

Expected: FAIL on missing final presentation or metadata behavior.

- [ ] **Step 3: Apply production UI polish**

Use the existing spacing and color tokens, remove the low-contrast `.tk-empty` color, keep focus outlines visible, constrain readable content width, and avoid nested decorative cards or gratuitous animation. Add `prefers-reduced-motion` handling only if a transition is introduced.

- [ ] **Step 4: Run automated regression gates**

Run:

```bash
pnpm --filter @tk/web test
pnpm --filter @tk/web typecheck
pnpm lint
pnpm exec playwright test e2e/templates.spec.ts --project=chromium
git diff --check
```

Expected: all commands PASS with no warnings.

- [ ] **Step 5: Verify through Chrome DevTools AutoConnect**

At desktop width, verify:

- UI template count equals `/api/v1/image-generation-templates` count.
- No console errors or warnings.
- No horizontal overflow.
- Lighthouse Accessibility >= 95 and Best Practices = 100.
- Performance trace LCP < 1.5s and CLS = 0.
- Do not activate existing test templates or invoke the real Planner during browser verification.

Record exact evidence and remaining risks in the verification report.

- [ ] **Step 6: Commit verification artifacts**

```bash
git add apps/web/src/app/globals.css e2e/templates.spec.ts docs/superpowers/reports/2026-08-09-image-template-production-readiness-verification.md
git commit -m "test(templates): verify production readiness"
```

### Task 6: Final integration audit

**Files:**
- No new production files expected.

**Interfaces:**
- Produces a clean, reviewable commit range on `main` while preserving unrelated working-tree changes.

- [ ] **Step 1: Review the exact change scope**

Run: `git diff ae76112..HEAD --stat && git status --short`

Expected: only template production-readiness commits plus the already committed design/plan; the two pre-existing modified files remain unstaged and unchanged by this work.

- [ ] **Step 2: Run the final focused smoke suite**

Run: `pnpm --filter @tk/web exec vitest run --config vitest.all.config.ts src/app/templates/page.test.tsx src/components/templates/image-generation-template-manager.test.tsx 'src/app/api/v1/image-generation-templates/[templateId]/prompt-test/route.test.ts'`

Expected: PASS.

- [ ] **Step 3: Report production status**

Report the final commit, automated test results, Chrome DevTools evidence, and any live Planner verification intentionally skipped to avoid cost.
