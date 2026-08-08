# Production Settings UI Implementation Plan

> **Execution owner:** one delegated implementation agent. Work only in the isolated worktree `/mnt/d/project/TKcaiji/tk-commerce-workbench/.worktrees/settings-production-ui` on branch `codex/settings-production-ui`.

**Goal:** Turn the desktop settings page into a clean, production-ready control surface and make non-secret image-generation settings configurable without implying that a running Worker changes instantly.

**Product contract:** The page separates saved workspace defaults from the active process state. Users can choose the image-generation path and edit planner/image model names, while API keys and provider endpoints remain environment-managed. Saving reports success, validation errors name the affected field, and any startup-bound change is visibly marked as requiring a Worker restart. Existing Canvas compatibility remains available.

**Stack:** Next.js App Router, React 19, TypeScript, CSS modules/global utility classes, Zod route validation, Vitest + Testing Library.

---

## Task 1: Lock the settings contract with failing tests

**Files:**
- Modify: `apps/web/src/server/services/settings-service.test.ts`
- Modify: `apps/web/src/app/api/v1/settings/route.test.ts`
- Modify/Create: settings component tests under `apps/web/src/components/settings/__tests__/`
- Modify: `packages/config/src/env.test.ts`

1. Add behavior tests for image-generation path (`headless | canvas`), planner model, image model, safe readiness status, and zero meaning unlimited Canvas runs.
2. Add UI tests that verify conditional Canvas/headless fields, saved-vs-active status, dirty tracking, discard, save, conflict/error recovery, accessible labels, and focus movement to the first invalid field.
3. Run the focused tests and record that they fail for the missing contract/behavior before implementation.

## Task 2: Extend the safe settings/readiness model

**Files:**
- Modify: `packages/config/src/env.ts`
- Modify: `apps/web/src/server/composition.ts`
- Modify: `apps/web/src/server/services/settings-service.ts`
- Modify: `apps/web/src/app/api/v1/settings/route.ts`
- Modify supporting fixtures/types as required.

1. Parse and expose only non-secret active runtime facts needed by the settings page: active generation path, planner model, image model, Canvas workflow, adapter mode, and readiness booleans.
2. Persist editable non-secret image-generation options in the existing `provider_options` JSON contract so no database migration is needed.
3. Keep secret values, provider URLs, and raw API keys out of API responses and logs.
4. Accept `maxCanvasRunsPerDay = 0` consistently in route validation, service mapping, input constraints, and help text.
5. Return explicit saved and active values so the UI can truthfully show `已应用` or `重启 Worker 后生效`; do not claim the browser restarts the Worker.

## Task 3: Rebuild the desktop settings information architecture

**Files:**
- Modify: `apps/web/src/components/settings/settings-workspace.tsx`
- Modify: `apps/web/src/components/settings/field.tsx`
- Modify: `apps/web/src/components/settings/save-bar.tsx`
- Modify existing files under `apps/web/src/components/settings/sections/`
- Add focused section components only where separation improves clarity.
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/settings/page.tsx` or its parent metadata file if needed.

1. Build a desktop two-column layout: a compact left section navigator/status summary and a wide right form.
2. Organize the form into `基础设置`, `生图与模型`, `稳定性`, `服务状态`, and a collapsed `高级设置` area.
3. In `生图与模型`, show path selection first. Headless mode shows planner/image model inputs and provider readiness; Canvas mode shows workflow and daily cap. Keep Listing provider/model visually separate.
4. Flatten nested cards, use 8/16/24/32 spacing, improve text/semantic-color contrast, and provide clear focus-visible styles.
5. Keep a sticky save bar with `保存更改` and `放弃更改`; show the changed-field count and startup-bound restart notice.
6. Use concise, actionable Chinese copy. No mobile-specific layout work, secret editor, or in-browser restart control.

## Task 4: Make failures recoverable and observable

**Files:**
- Modify the settings workspace/save hook and tests.

1. Surface field-level validation beside inputs and move focus to the first invalid field.
2. Preserve optimistic version conflict handling and explain how to reload when another session changed settings.
3. Keep unsaved-change protection, keyboard save, disabled/loading states, and retry after network errors.
4. Ensure native controls have stable `id`, `name`, labels, and descriptions.

## Task 5: Verify production quality

1. Run focused red/green tests for config, API/service, and settings components.
2. Run `pnpm typecheck`, relevant lint/tests, and `git diff --check`.
3. Start the app using the repository startup path or a safe isolated development port.
4. Verify `/settings` at desktop width with Chrome DevTools/agent-browser: no console errors, no failed requests, keyboard navigation works, contrast and form-name warnings are resolved, save/discard works, and conditional generation settings render correctly.
5. Review the final diff for secret leakage, misleading runtime claims, unrelated edits, and accidental mobile scope.
6. Commit the completed change on `codex/settings-production-ui` with a focused message.
