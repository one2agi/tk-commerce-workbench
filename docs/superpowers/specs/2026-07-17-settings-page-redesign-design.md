# Settings Page UI Redesign — Design

**Date:** 2026-07-17
**Status:** Awaiting user review
**Owner:** web team

## Context

The current `/settings` page at `apps/web/src/app/settings/page.tsx` and
`apps/web/src/components/settings/settings-editor.tsx` renders 17+ editable
fields in a single flat `<form>`. Users cannot tell at a glance which fields
are commonly used, which affect the running Worker, or what changed since the
last save. The secret-status display is buried in a definition list. The
"save changes" feedback is a small `<output>` element next to the submit
button at the bottom of a long form, which is easy to miss.

This redesign restructures the page into five clearly grouped cards, adds a
sticky save bar with dirty-field tracking and conflict handling, and turns
the secret-status block into a scannable row of status pills. The visual
language stays consistent with the existing design tokens (light theme, blue
accent `#2563eb`, 12px card radius, soft shadow). The settings-service
contract and `/api/v1/settings` API are unchanged.

## Goals

1. **Reduce visual noise** — group 17 fields into 5 cards so users can scan
   the page in one screen on a typical laptop.
2. **Make the "running Worker" rule visible** — replace the buried
   `applicationNote` paragraph at the top with a clearly styled info banner
   that explains changes apply on next start, not to a running process.
3. **Track unsaved changes** — show which fields were modified, allow
   discarding, and gate the save action.
4. **Handle conflicts gracefully** — show distinct UI for 200 / 409 / 5xx
   responses with actionable next steps.
5. **Stay within the existing design system** — no Tailwind, no new
   component library, no new color tokens.

## Non-goals

- No multi-user collaboration or real-time sync.
- No settings history / rollback beyond `baseline + draft` in memory.
- No dark mode, i18n, or mobile-specific layout beyond responsive collapse.
- No new API contract or settings-service changes.

## Architecture

### Component tree

```
page.tsx (Server Component)
└── SettingsWorkspace (Client Component)
    ├── InfoBanner
    ├── BasicSettingsSection       → SettingsCard shell
    ├── PricingFormulaSection      → SettingsCard shell
    ├── ProviderOptionsSection     → SettingsCard shell
    ├── RetryPolicySection         → SettingsCard shell
    ├── SecretStatusSection        → SettingsCard shell (read-only)
    └── SaveBar (sticky, conditional)

Reusable primitives:
- SettingsCard     (header + body shell)
- Field            (label + input + help + optional dirty marker)
- StatusPill       (configured / not-configured indicator)
```

### Server/client boundary

- `page.tsx` (server) calls `settingsService.get()` and passes the result
  to `<SettingsWorkspace settings={...} />`.
- `SettingsWorkspace` is the only `"use client"` boundary for the page.
- All section components receive the same `draft`, `baseline`,
  `dirtyFields`, and `onChange` props — no per-section state.

### State model

```ts
type SettingsDraftState = {
  baseline: WorkspaceSettingsView;       // server truth, updated on save
  draft: WorkspaceSettingsView;          // user-edited values
  dirtyFields: ReadonlySet<string>;      // flat key list, e.g. "pricingDefaults.platformFeeRate"
  saveState: "idle" | "saving" | "saved" | "conflict" | "error";
  saveError: string | null;
  toast: { kind: "info" | "success" | "error"; message: string } | null;
};
```

- `dirtyFields` is derived via `useMemo` deep-comparing `draft` vs
  `baseline`, then flattened to dot-notation keys.
- All inputs are **controlled** (`value` + `onChange`), not uncontrolled
  with `defaultValue`, so dirty tracking is reliable.
- The save bar is rendered only when `dirtyFields.size > 0` OR
  `saveState !== "idle"`.

### Data flow

```
input onChange
  → SettingsWorkspace.setDraftField(key, value)
  → draft state update
  → dirtyFields recomputed via useMemo
  → SaveBar re-renders with new count
  → Field re-renders with dirty marker

click Save / ⌘+S
  → useSaveSettings.save(draft, baseline)
  → fetch PATCH /api/v1/settings { expectedVersion: baseline.version, ...draft }
  → on 200: setBaseline(response), clearDraft, toast success
  → on 409: saveState = "conflict", show refresh actions
  → on 5xx: saveState = "error", retain draft
```

### File layout

```
apps/web/src/components/settings/
├── settings-workspace.tsx              ← top-level client component
├── settings-card.tsx                   ← card shell with header + body
├── field.tsx                           ← label + control + help + dirty marker
├── status-pill.tsx                     ← read-only env-config indicator
├── info-banner.tsx                     ← top "running worker" notice
├── save-bar.tsx                        ← sticky bottom save bar
├── sections/
│   ├── basic-settings-section.tsx
│   ├── pricing-formula-section.tsx
│   ├── provider-options-section.tsx
│   ├── retry-policy-section.tsx
│   └── secret-status-section.tsx
└── settings-workspace.test.tsx         ← new
```

The existing `apps/web/src/components/settings/settings-editor.tsx` is
deleted. Any callers (`apps/web/src/components/operations-editors.test.tsx`
if it imports internals) are migrated before deletion.

### Visual tokens

All tokens are reused from the existing system; no new tokens added.

| Token | Value | Reuse source |
|---|---|---|
| Card radius | 12px | `.tk-product-table` |
| Card border | `#d9e0e9` | existing panels |
| Card shadow (resting) | `0 1px 2px rgba(15,23,42,.04)` | new, matches existing 5% opacity |
| Card shadow (sticky bar) | `0 6px 18px rgba(15,23,42,.08)` | matches `.tk-product-drawer` |
| Primary | `#2563eb` / hover `#1d4ed8` | existing |
| Title color | `#172033` | existing |
| Body color | `#526174` / `#64748b` | existing |
| Success bg | `#d1fae5` + text `#047857` | new, semantic |
| Warning bg | `#fef3c7` + text `#b45309` | new, semantic |
| Unsaved bg | `#eff6ff` + dot `#1d4ed8` | new, semantic |

All new CSS classes use the `tk-settings-` prefix.

## Behavior

### Section: Basic Settings (card #1)

| Field | Control | Help |
|---|---|---|
| `defaultLocale` | select (`zh-CN` / `th-TH` / `en-US`) | 新建商品时默认使用 |
| `defaultCurrency` | select (`CNY` / `THB` / `USD`) | 利润换算的目标币种 |
| `externalAdapterMode` | select (`mock` / `live`) | mock = 仅本地模拟；live = 真实调用外部 API |
| `workerConcurrency` | number input | 同时处理的商品任务数 |
| `maxCanvasRunsPerDay` | number input | 0 表示不限制 |
| `assetRoot` | text input | Worker 写文件的绝对路径 |

Layout: 2-column grid on viewports ≥ 1024px; single column below.

### Section: Pricing Formula (card #2)

| Field | Control | Help |
|---|---|---|
| `domesticShippingCny` | number (2 decimals) | 每件商品分摊的国内发货成本 |
| `crossBorderCostCny` | number | 头程 + 尾程物流综合 |
| `fixedTargetCostThb` | number | 包装/标签等 |
| `platformFeeRate` | percent (e.g. 0.05 = 5%) | 妙手平台抽佣 |
| `paymentFeeRate` | percent | 支付通道手续费 |
| `targetProfitRate` | percent | 售价中利润占比 |
| `ending` | integer 0-9 | 售价尾数；9 表示以 .9 结尾 |

Layout: 3-column grid for the first six fields; full-width row for `ending`.

### Section: Provider Defaults (card #3)

Three single-line text inputs in one column, each with a help line explaining
the expected format (e.g. "miaoshou" or "custom").

### Section: Retry Policy (card #4)

Two number inputs side by side:

- `maxAttempts` (1-20, includes the first execution)
- `initialDelaySeconds` (exponential backoff multiplier)

### Section: Secret Status (card #5, read-only)

Displays four status pills:

- 妙手 (`MIAOSHOU_APP_KEY` / `MIAOSHOU_APP_SECRET`)
- Canvas (`CANVAS_API_KEY`)
- LLM (`LLM_API_KEY`)
- 汇率 (`EXCHANGE_RATE_API_KEY`)

Each pill shows:
- Icon (✓ or ⚠) + name
- Env-var names on hover
- Configured = green pill; Not configured = amber pill (yellow chosen over red
  to avoid implying a fault in user action)

A short caption explains: "密钥不会进入浏览器或保存到本页面。修改后需要重启 Worker 进程才能生效。"

### Info banner (top of page)

A single info banner with a `ℹ` icon:

> 修改这些值只更新工作区默认值。已启动的 Worker 不会被自动重配，需要重启进程才能生效。

Replaces the existing `applicationNote` paragraph rendered inside the form.

### Save bar (sticky, bottom of viewport)

Visible only when `dirtyFields.size > 0` OR `saveState !== "idle"`.

Layout:

```
[● N 项已修改 · 当前版本 v{N}]               [放弃修改]  [保存设置]
```

States:

| State | Background | Right-side buttons |
|---|---|---|
| dirty | white | 放弃修改 (ghost) · 保存设置 (primary) |
| saving | white | 按钮 disabled + spinner |
| saved (transient, 1.5s) | white, "✓ 已保存" inline | 全部隐藏 |
| conflict | light red `#fee2e2` | "已被其他页面更新" + [刷新] [放弃并刷新] |
| error | light red `#fee2e2` | "保存失败，请稍后重试" + [再试一次] |

### Dirty markers

Each modified `<Field>` displays a 4px blue dot on the right side of the
input. The card's `<h2>` gets a small "（已改）" tag when any of its
fields are dirty.

### Toast

For successful saves only (failure is communicated inline in the save bar).
Bottom-right, 5-second auto-dismiss. No third-party library — implemented
with a single `<output>` element + CSS transition.

### Keyboard shortcuts

- `⌘+S` / `Ctrl+S` while focus is inside the page → triggers save (only when
  `dirtyFields.size > 0` and `saveState !== "saving"`).
- `Esc` while focus is inside the page → no-op (does not discard).
- `beforeunload` listener registered only while `dirtyFields.size > 0`.

## Error handling

| Scenario | Behavior |
|---|---|
| PATCH 200 | `setBaseline(response)`, clear dirty, save bar hides, toast success |
| PATCH 409 | Save bar turns red, shows "设置已被其他页面更新", buttons: 刷新 (router.refresh) / 放弃并刷新 (setDraft = baseline, then router.refresh) |
| PATCH 5xx / network | Save bar turns red, "保存失败，请稍后重试", [再试一次] re-issues the same request, draft preserved |
| Save in flight | Save button disabled, ⌘+S suppressed |
| User clicks Save with no dirty fields | No-op (button hidden in this state) |
| Field validation failure (client-side) | Field shows inline error text below input, save blocked until fixed |

Client-side validation rules match the existing HTML constraints
(`required`, `min`, `max`, `type="number"`) plus new explicit checks:

- `defaultLocale` ∈ {zh-CN, th-TH, en-US}
- `defaultCurrency` ∈ {CNY, THB, USD}
- `externalAdapterMode` ∈ {mock, live}
- `workerConcurrency` ∈ [1, 32]
- `maxCanvasRunsPerDay` ≥ 1
- All pricing percentages ∈ [0, 1]
- `ending` ∈ [0, 9]
- `maxAttempts` ∈ [1, 20]
- `initialDelaySeconds` ≥ 1
- `assetRoot` is a non-empty absolute path

## Testing

### New: `settings-workspace.test.tsx`

| Scenario | Assertion |
|---|---|
| Initial render | every input value === baseline value; save bar absent |
| Modify one input | save bar shows "已修改 1 项", that input has dirty marker, save bar absent if user reverts |
| Modify three inputs | save bar shows "已修改 3 项" |
| Click "放弃修改" | all inputs reset to baseline, save bar hidden, dirtyFields.size === 0 |
| ⌘+S triggers save (mock 200) | fetch called once, body has expectedVersion === baseline.version |
| Save 200 | baseline updates to response, dirty clears, save bar hides, toast appears |
| Save 409 | save bar turns red with conflict copy, dirty not cleared |
| Save 500 | save bar turns red with error copy, dirty not cleared, draft retained |
| Save in flight | save button disabled, ⌘+S suppressed |
| ⌘+S in idle state | fetch NOT called |
| beforeunload listener | registered when dirty, removed when clean |
| Each section's `<Field>` renders label, control, help text correctly | snapshot-style assertions |

### New: `field.test.tsx`

- Renders label, control, help text.
- Shows dirty marker only when `isDirty === true`.
- Shows validation error when `error` prop is set.

### New: `info-banner.test.tsx`

- Renders the running-worker explanation text.

### New: `secret-status-section.test.tsx`

- Renders four pills with correct env-var names.
- Configured pills use green styling; unconfigured use amber.

### Existing tests

- `apps/web/src/app/api/v1/settings/*` — unchanged (API contract preserved).
- `apps/web/src/server/services/settings-service.test.ts` (if any) — unchanged.
- `apps/web/src/components/operations-editors.test.tsx` — audited for
  `SettingsEditor` imports before that file is deleted; migrated to
  reference the new section components if needed.

### Visual regression

Not added in this iteration. New classes use stable `tk-settings-` prefixes
to make future visual-snapshot tooling (Chromatic / Playwright) easy to
retrofit.

### Manual smoke checklist (run after implementation)

- [ ] Open `/settings` → all five cards render with current values.
- [ ] No save bar visible.
- [ ] Change `defaultLocale` → save bar appears with "1 项已修改"; dot appears
      next to the changed field; card title gets "（已改）" tag.
- [ ] Click "放弃修改" → bar disappears; field reverts.
- [ ] Change a pricing field, click "保存设置" → toast appears; bar hides;
      version increments in header.
- [ ] Open in two tabs. Tab A saves a value. Tab B modifies a different value
      and tries to save → 409 → red bar with refresh actions.
- [ ] `⌘+S` (or `Ctrl+S` on Linux) while focused on a field → triggers save
      if dirty.
- [ ] Resize to < 1024px → cards collapse to single column.
- [ ] All secret pills show correct configured / not-configured state.

## Critical files

| File | Reason |
|---|---|
| `apps/web/src/app/settings/page.tsx` | Reduce to data fetch + render client component |
| `apps/web/src/components/settings/settings-workspace.tsx` (new) | Top-level client component |
| `apps/web/src/components/settings/settings-editor.tsx` | Delete after migration |
| `apps/web/src/components/settings/settings-card.tsx` (new) | Card shell |
| `apps/web/src/components/settings/field.tsx` (new) | Reusable field primitive |
| `apps/web/src/components/settings/status-pill.tsx` (new) | Read-only env indicator |
| `apps/web/src/components/settings/info-banner.tsx` (new) | Top notice |
| `apps/web/src/components/settings/save-bar.tsx` (new) | Sticky save bar |
| `apps/web/src/components/settings/sections/*.tsx` (new) | Per-section content |
| `apps/web/src/components/settings/settings-workspace.test.tsx` (new) | Behavior tests |
| `apps/web/src/app/globals.css` | Add `tk-settings-*` classes |
| `apps/web/src/components/operations-editors.test.tsx` | Audit SettingsEditor imports |
| `docs/superpowers/specs/2026-07-17-settings-page-redesign-design.md` | This doc |

## Existing functions / utilities to reuse

- `saveSettings()` from the current `settings-editor.tsx` — split into
  `useSaveSettings()` hook + `patchSettings()` pure function for testability.
- `.tk-page-heading` for the page header.
- `.tk-panel` styles (border + radius + shadow) as the visual basis for
  `tk-settings-card`.
- Existing `WorkspaceSettingsView` type from `settings-service.ts`.
- Existing `SettingsService.update()` and PATCH `/api/v1/settings` endpoint.

## Verification

Run in this order from repo root:

```bash
pnpm --filter @tk/web test
pnpm --filter @tk/web lint
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web build
```

Manual smoke against the running local-production service:

```bash
node scripts/local-production-runtime.mjs status
# Open http://127.0.0.1:3000/settings in browser
# Walk through the manual smoke checklist above
```

Acceptance gate: all unit tests pass, lint clean, typecheck clean, build
clean, manual smoke checklist fully ticked.