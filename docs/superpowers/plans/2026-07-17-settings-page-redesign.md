# Settings Page UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `/settings` from a 17-field flat form into five grouped cards with a sticky save bar, dirty-field tracking, conflict handling, and a scannable secret-status pill row.

**Architecture:** Single client component (`SettingsWorkspace`) owns the draft/baseline state and dirty tracking; five read-mostly section components consume it. Settings-service and `/api/v1/settings` API contract are unchanged.

**Tech Stack:** Next.js 16 (app router), React 19, TypeScript, Vitest + Testing Library, plain CSS with `tk-settings-*` class prefix.

**Spec:** `docs/superpowers/specs/2026-07-17-settings-page-redesign-design.md`

**Prototype:** `docs/superpowers/specs/prototypes/settings-page.html`

## Global Constraints

- **No new dependencies.** Use only React 19, TypeScript, Next.js, Vitest, Testing Library already in `apps/web/package.json`.
- **No Tailwind, no CSS-in-JS.** Plain CSS only, classes in `apps/web/src/app/globals.css`, prefix `tk-settings-`.
- **Settings-service API contract preserved.** `SettingsService.update()`, `SettingsConflictError`, PATCH `/api/v1/settings` keep current signatures.
- **Visual tokens reused:** `#2563eb` primary, `#172033` title, `#526174`/`#64748b` body, `#d9e0e9` borders, `#fff` panels, 12px radius, shadows `rgba(15,23,42,.04)` / `.08`.
- **Validation rules (client-side):** `defaultLocale ∈ {zh-CN, th-TH, en-US}`; `defaultCurrency ∈ {CNY, THB, USD}`; `externalAdapterMode ∈ {mock, live}`; `workerConcurrency ∈ [1, 32]`; `maxCanvasRunsPerDay ≥ 1`; pricing percentages ∈ [0, 1]; `ending ∈ [0, 9]`; `maxAttempts ∈ [1, 20]`; `initialDelaySeconds ≥ 1`; `assetRoot` non-empty absolute path.
- **Lint clean** (`pnpm --filter @tk/web lint` — max-warnings 0), **typecheck clean** (`tsc --noEmit`), **all tests pass** (`pnpm --filter @tk/web test`), **build clean** (`pnpm --filter @tk/web build`).
- **Frequent commits.** One commit per task minimum. Conventional commit prefixes (`feat:`, `test:`, `chore:`, `refactor:`).
- **Branch:** work on `main` per project instruction (commit directly). No new feature branch.
- **Server is still running** at `http://127.0.0.1:3000`. After each meaningful task, restart not required unless instructed.

---

## File Layout

### Created

```
apps/web/src/components/settings/
├── settings-workspace.tsx              ← top-level client orchestrator
├── settings-card.tsx                   ← card shell (header + body)
├── field.tsx                           ← label + control + help + dirty marker
├── status-pill.tsx                     ← read-only env indicator
├── info-banner.tsx                     ← top "running worker" notice
├── save-bar.tsx                        ← sticky bottom save bar
├── settings-api.ts                     ← saveSettings() + useSaveSettings()
├── dirty.ts                            ← setNestedField + computeDirtyFields
└── sections/
    ├── basic-settings-section.tsx
    ├── pricing-formula-section.tsx
    ├── provider-options-section.tsx
    ├── retry-policy-section.tsx
    └── secret-status-section.tsx

apps/web/src/components/settings/__tests__/
├── field.test.tsx
├── settings-card.test.tsx
├── status-pill.test.tsx
├── info-banner.test.tsx
├── save-bar.test.tsx
├── dirty.test.ts
├── sections.test.tsx                   ← covers all 5 sections
└── settings-workspace.test.tsx
```

### Modified

- `apps/web/src/app/settings/page.tsx` — reduce to data fetch + render `<SettingsWorkspace>`
- `apps/web/src/app/globals.css` — append `tk-settings-*` classes
- `apps/web/src/components/operations-editors.test.tsx` — point `saveSettings` import to `settings-api.ts`

### Deleted

- `apps/web/src/components/settings/settings-editor.tsx` — after migration

---

## Task 1: `dirty.ts` — setNestedField + computeDirtyFields helpers

**Files:**
- Create: `apps/web/src/components/settings/dirty.ts`
- Create: `apps/web/src/components/settings/__tests__/dirty.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `setNestedField<T>(obj: T, dottedPath: string, value: unknown): T`, `computeDirtyFields(baseline, draft): ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/settings/__tests__/dirty.test.ts
import { describe, expect, it } from "vitest";

import { computeDirtyFields, setNestedField } from "../dirty";
import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

function baselineFixture(): WorkspaceSettingsView {
  return {
    version: 1,
    defaultLocale: "zh-CN",
    defaultCurrency: "CNY",
    externalAdapterMode: "mock",
    workerConcurrency: 4,
    maxCanvasRunsPerDay: 50,
    assetRoot: "/tmp/assets",
    pricingDefaults: {
      domesticShippingCny: "8.50",
      crossBorderCostCny: "35.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.050",
      paymentFeeRate: "0.006",
      targetProfitRate: "0.20",
      ending: "9"
    },
    providerOptions: { listingProvider: "miaoshou", listingModel: "v3", canvasWorkflow: "wf-1" },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true },
    applicationNote: ""
  };
}

describe("setNestedField", () => {
  it("sets a top-level field immutably", () => {
    const before = baselineFixture();
    const after = setNestedField(before, "defaultLocale", "th-TH");
    expect(after).not.toBe(before);
    expect(after.defaultLocale).toBe("th-TH");
    expect(before.defaultLocale).toBe("zh-CN");
  });

  it("sets a nested field immutably without mutating siblings", () => {
    const before = baselineFixture();
    const after = setNestedField(before, "pricingDefaults.targetProfitRate", "0.30");
    expect(after.pricingDefaults).not.toBe(before.pricingDefaults);
    expect(after.pricingDefaults.targetProfitRate).toBe("0.30");
    expect(after.pricingDefaults.platformFeeRate).toBe("0.050");
    expect(before.pricingDefaults.targetProfitRate).toBe("0.20");
  });
});

describe("computeDirtyFields", () => {
  it("returns an empty set when draft equals baseline", () => {
    const b = baselineFixture();
    expect(computeDirtyFields(b, { ...b }).size).toBe(0);
  });

  it("detects a top-level scalar change", () => {
    const b = baselineFixture();
    const dirty = computeDirtyFields(b, { ...b, defaultLocale: "en-US" });
    expect([...dirty]).toEqual(["defaultLocale"]);
  });

  it("detects a nested change and reports dotted key", () => {
    const b = baselineFixture();
    const draft = { ...b, pricingDefaults: { ...b.pricingDefaults, ending: "5" } };
    const dirty = computeDirtyFields(b, draft);
    expect([...dirty]).toEqual(["pricingDefaults.ending"]);
  });

  it("reports multiple dirty fields", () => {
    const b = baselineFixture();
    const draft = {
      ...b,
      externalAdapterMode: "live" as const,
      pricingDefaults: { ...b.pricingDefaults, ending: "5", platformFeeRate: "0.060" }
    };
    const dirty = computeDirtyFields(b, draft);
    expect([...dirty].sort()).toEqual([
      "externalAdapterMode",
      "pricingDefaults.ending",
      "pricingDefaults.platformFeeRate"
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/dirty.test.ts
```

Expected: FAIL with "Cannot find module '../dirty'" or similar.

- [ ] **Step 3: Implement `dirty.ts`**

```ts
// apps/web/src/components/settings/dirty.ts
import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export function setNestedField<T>(obj: T, dottedPath: string, value: unknown): T {
  const keys = dottedPath.split(".");
  const clone = structuredClone(obj) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    cursor[key] = { ...(cursor[key] as Record<string, unknown>) };
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
  return clone as T;
}

type ScalarKey = "defaultLocale" | "defaultCurrency" | "externalAdapterMode" | "assetRoot" | "workerConcurrency" | "maxCanvasRunsPerDay";

const SCALAR_KEYS: ReadonlyArray<ScalarKey> = [
  "defaultLocale",
  "defaultCurrency",
  "externalAdapterMode",
  "assetRoot",
  "workerConcurrency",
  "maxCanvasRunsPerDay"
];

const NESTED_GROUPS: ReadonlyArray<"pricingDefaults" | "providerOptions" | "retryPolicy"> = [
  "pricingDefaults",
  "providerOptions",
  "retryPolicy"
];

export function computeDirtyFields(
  baseline: WorkspaceSettingsView,
  draft: WorkspaceSettingsView
): ReadonlySet<string> {
  const dirty = new Set<string>();
  for (const key of SCALAR_KEYS) {
    if (baseline[key] !== draft[key]) dirty.add(key);
  }
  for (const group of NESTED_GROUPS) {
    const baseGroup = baseline[group] as Record<string, unknown>;
    const draftGroup = draft[group] as Record<string, unknown>;
    for (const subKey of Object.keys(baseGroup)) {
      if (baseGroup[subKey] !== draftGroup[subKey]) {
        dirty.add(`${group}.${subKey}`);
      }
    }
  }
  return dirty;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/dirty.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/dirty.ts apps/web/src/components/settings/__tests__/dirty.test.ts
git commit -m "feat(settings): add setNestedField and computeDirtyFields helpers"
```

---

## Task 2: `field.tsx` — reusable field primitive

**Files:**
- Create: `apps/web/src/components/settings/field.tsx`
- Create: `apps/web/src/components/settings/__tests__/field.test.tsx`

**Interfaces:**
- Consumes: `label: string`, `help?: string`, `isDirty?: boolean`, `error?: string`, plus render-prop children for the control
- Produces: `<Field>` component rendered with `tk-field` class

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/__tests__/field.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Field } from "../field";

describe("Field", () => {
  it("renders label, control children, and help text", () => {
    render(
      <Field label="默认语言" help="新建商品时使用">
        <input data-testid="control" />
      </Field>
    );
    expect(screen.getByText("默认语言")).toBeInTheDocument();
    expect(screen.getByTestId("control")).toBeInTheDocument();
    expect(screen.getByText("新建商品时使用")).toBeInTheDocument();
  });

  it("renders the dirty marker only when isDirty is true", () => {
    const { rerender, container } = render(
      <Field label="A">
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__dirty-dot")).toBeNull();

    rerender(
      <Field label="A" isDirty>
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__dirty-dot")).not.toBeNull();
  });

  it("renders error text below the control when error is set", () => {
    render(
      <Field label="并发" error="必须在 1-32 之间">
        <input />
      </Field>
    );
    expect(screen.getByText("必须在 1-32 之间")).toBeInTheDocument();
  });

  it("omits help when not provided", () => {
    const { container } = render(
      <Field label="A">
        <input />
      </Field>
    );
    expect(container.querySelector(".tk-field__help")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/field.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `field.tsx`**

```tsx
// apps/web/src/components/settings/field.tsx
import type { ReactNode } from "react";

export interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  isDirty?: boolean;
  children: ReactNode;
}

export function Field({ label, help, error, isDirty, children }: FieldProps): JSX.Element {
  return (
    <label className="tk-field">
      <span className="tk-field__label">{label}</span>
      <span className={`tk-field__control${isDirty ? " is-dirty" : ""}`}>
        {children}
        {isDirty ? <span className="tk-field__dirty-dot" aria-hidden /> : null}
      </span>
      {error ? (
        <span className="tk-field__error" role="alert">{error}</span>
      ) : help ? (
        <span className="tk-field__help">{help}</span>
      ) : null}
    </label>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/field.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/field.tsx apps/web/src/components/settings/__tests__/field.test.tsx
git commit -m "feat(settings): add Field primitive component"
```

---

## Task 3: `settings-card.tsx` — card shell

**Files:**
- Create: `apps/web/src/components/settings/settings-card.tsx`
- Create: `apps/web/src/components/settings/__tests__/settings-card.test.tsx`

**Interfaces:**
- Consumes: `title: string`, `hint?: string`, `dirtyCount?: number`, `ariaLabel: string`, children
- Produces: `<SettingsCard>` rendered with `tk-settings-card` class; `dirtyCount > 0` renders "已改 N 项" badge

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/__tests__/settings-card.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsCard } from "../settings-card";

describe("SettingsCard", () => {
  it("renders title, hint, and body content", () => {
    render(
      <SettingsCard title="基础设置" hint="默认参数" ariaLabel="基础设置">
        <div>body</div>
      </SettingsCard>
    );
    expect(screen.getByRole("heading", { name: "基础设置" })).toBeInTheDocument();
    expect(screen.getByText("默认参数")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("hides the dirty badge when dirtyCount is 0 or undefined", () => {
    const { rerender, container } = render(
      <SettingsCard title="A" ariaLabel="A">
        <div />
      </SettingsCard>
    );
    expect(container.querySelector(".tk-settings-card__dirty")).toBeNull();

    rerender(
      <SettingsCard title="A" dirtyCount={0} ariaLabel="A">
        <div />
      </SettingsCard>
    );
    expect(container.querySelector(".tk-settings-card__dirty")).toBeNull();
  });

  it("renders the dirty badge with count when dirtyCount > 0", () => {
    render(
      <SettingsCard title="定价" dirtyCount={3} ariaLabel="定价">
        <div />
      </SettingsCard>
    );
    expect(screen.getByText("已改 3 项")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-card.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `settings-card.tsx`**

```tsx
// apps/web/src/components/settings/settings-card.tsx
import type { ReactNode } from "react";

export interface SettingsCardProps {
  title: string;
  hint?: string;
  dirtyCount?: number;
  ariaLabel: string;
  children: ReactNode;
}

export function SettingsCard({ title, hint, dirtyCount, ariaLabel, children }: SettingsCardProps): JSX.Element {
  return (
    <section className="tk-settings-card" aria-label={ariaLabel}>
      <header className="tk-settings-card__head">
        <span className="tk-settings-card__accent" aria-hidden />
        <div className="tk-settings-card__title">
          <h2>{title}</h2>
          {hint ? <span className="tk-settings-card__hint">{hint}</span> : null}
        </div>
        {dirtyCount && dirtyCount > 0 ? (
          <span className="tk-settings-card__dirty">已改 {dirtyCount} 项</span>
        ) : null}
      </header>
      <div className="tk-settings-card__body">{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-card.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/settings-card.tsx apps/web/src/components/settings/__tests__/settings-card.test.tsx
git commit -m "feat(settings): add SettingsCard shell component"
```

---

## Task 4: `status-pill.tsx` + `info-banner.tsx` — read-only components

**Files:**
- Create: `apps/web/src/components/settings/status-pill.tsx`
- Create: `apps/web/src/components/settings/info-banner.tsx`
- Create: `apps/web/src/components/settings/__tests__/status-pill.test.tsx`
- Create: `apps/web/src/components/settings/__tests__/info-banner.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/__tests__/status-pill.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusPill } from "../status-pill";

describe("StatusPill", () => {
  it("renders configured state with checkmark and green class", () => {
    const { container } = render(
      <StatusPill name="妙手" envVars="MIAOSHOU_APP_KEY / _SECRET" configured />
    );
    expect(screen.getByText("妙手")).toBeInTheDocument();
    expect(screen.getByText("MIAOSHOU_APP_KEY / _SECRET")).toBeInTheDocument();
    expect(container.querySelector(".tk-pill.is-ok")).not.toBeNull();
    expect(container.querySelector(".tk-pill.is-warn")).toBeNull();
  });

  it("renders not-configured state with warning icon and amber class", () => {
    const { container } = render(
      <StatusPill name="汇率" envVars="EXCHANGE_RATE_API_KEY" configured={false} />
    );
    expect(container.querySelector(".tk-pill.is-warn")).not.toBeNull();
    expect(container.querySelector(".tk-pill.is-ok")).toBeNull();
  });
});
```

```tsx
// apps/web/src/components/settings/__tests__/info-banner.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InfoBanner } from "../info-banner";

describe("InfoBanner", () => {
  it("renders the running-worker rule", () => {
    render(<InfoBanner />);
    expect(
      screen.getByText(/修改这些值只更新工作区默认值/)
    ).toBeInTheDocument();
    expect(screen.getByText(/重启进程/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/status-pill.test.tsx src/components/settings/__tests__/info-banner.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `status-pill.tsx`**

```tsx
// apps/web/src/components/settings/status-pill.tsx
export interface StatusPillProps {
  name: string;
  envVars: string;
  configured: boolean;
}

export function StatusPill({ name, envVars, configured }: StatusPillProps): JSX.Element {
  return (
    <div
      className={`tk-pill ${configured ? "is-ok" : "is-warn"}`}
      title={envVars}
    >
      <span className="tk-pill__icon" aria-hidden>
        {configured ? "✓" : "!"}
      </span>
      <div className="tk-pill__body">
        <div className="tk-pill__name">{name}</div>
        <div className="tk-pill__env">{envVars}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `info-banner.tsx`**

```tsx
// apps/web/src/components/settings/info-banner.tsx
export function InfoBanner(): JSX.Element {
  return (
    <div className="tk-info-banner" role="note">
      <span className="tk-info-banner__icon" aria-hidden>
        ℹ
      </span>
      <div className="tk-info-banner__body">
        <strong>修改这些值只更新工作区默认值。</strong>
        已启动的 Worker 不会被自动重配，需要<strong>重启进程</strong>才能生效。
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/status-pill.test.tsx src/components/settings/__tests__/info-banner.test.tsx
```

Expected: PASS, 3 tests total.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/status-pill.tsx apps/web/src/components/settings/info-banner.tsx apps/web/src/components/settings/__tests__/status-pill.test.tsx apps/web/src/components/settings/__tests__/info-banner.test.tsx
git commit -m "feat(settings): add StatusPill and InfoBanner read-only components"
```

---

## Task 5: Five section components

**Files:**
- Create: `apps/web/src/components/settings/sections/basic-settings-section.tsx`
- Create: `apps/web/src/components/settings/sections/pricing-formula-section.tsx`
- Create: `apps/web/src/components/settings/sections/provider-options-section.tsx`
- Create: `apps/web/src/components/settings/sections/retry-policy-section.tsx`
- Create: `apps/web/src/components/settings/sections/secret-status-section.tsx`
- Create: `apps/web/src/components/settings/__tests__/sections.test.tsx`

**Interfaces (shared):**
- Each section consumes: `draft: WorkspaceSettingsView`, `dirtyFields: ReadonlySet<string>`, `onFieldChange: (dottedPath: string, value: unknown) => void`, optional `secretStatus` for secret-status section.
- Sections are pure presentational components.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/__tests__/sections.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { BasicSettingsSection } from "../sections/basic-settings-section";
import { PricingFormulaSection } from "../sections/pricing-formula-section";
import { ProviderOptionsSection } from "../sections/provider-options-section";
import { RetryPolicySection } from "../sections/retry-policy-section";
import { SecretStatusSection } from "../sections/secret-status-section";

function viewFixture(overrides: Partial<WorkspaceSettingsView> = {}): WorkspaceSettingsView {
  return {
    version: 1,
    defaultLocale: "zh-CN",
    defaultCurrency: "CNY",
    externalAdapterMode: "mock",
    workerConcurrency: 4,
    maxCanvasRunsPerDay: 50,
    assetRoot: "/tmp/assets",
    pricingDefaults: {
      domesticShippingCny: "8.50",
      crossBorderCostCny: "35.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.050",
      paymentFeeRate: "0.006",
      targetProfitRate: "0.20",
      ending: "9"
    },
    providerOptions: { listingProvider: "miaoshou", listingModel: "v3", canvasWorkflow: "wf-1" },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: false },
    applicationNote: "",
    ...overrides
  };
}

describe("BasicSettingsSection", () => {
  it("renders all six controls with values from draft", () => {
    render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("zh-CN")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CNY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("mock")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();
    expect(screen.getByDisplayValue("50")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/tmp/assets")).toBeInTheDocument();
  });

  it("calls onFieldChange with dotted key when defaultLocale changes", async () => {
    const user = userEvent.setup();
    const onFieldChange = vi.fn();
    render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={onFieldChange}
      />
    );
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    expect(onFieldChange).toHaveBeenCalledWith("defaultLocale", "th-TH");
  });
});

describe("PricingFormulaSection", () => {
  it("renders all seven pricing fields", () => {
    render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("8.50")).toBeInTheDocument();
    expect(screen.getByDisplayValue("35.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10.00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.050")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.006")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0.20")).toBeInTheDocument();
    expect(screen.getByDisplayValue("9")).toBeInTheDocument();
  });

  it("calls onFieldChange with nested key when ending changes", async () => {
    const user = userEvent.setup();
    const onFieldChange = vi.fn();
    render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={onFieldChange}
      />
    );
    await user.clear(screen.getByDisplayValue("9"));
    await user.type(screen.getByLabelText("价格尾数"), "5");
    expect(onFieldChange).toHaveBeenCalledWith("pricingDefaults.ending", "5");
  });
});

describe("ProviderOptionsSection", () => {
  it("renders three provider fields", () => {
    render(
      <ProviderOptionsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("miaoshou")).toBeInTheDocument();
    expect(screen.getByDisplayValue("v3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("wf-1")).toBeInTheDocument();
  });
});

describe("RetryPolicySection", () => {
  it("renders maxAttempts and initialDelaySeconds", () => {
    render(
      <RetryPolicySection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("30")).toBeInTheDocument();
  });
});

describe("SecretStatusSection", () => {
  it("renders four pills with the configured state for each", () => {
    const { container } = render(
      <SecretStatusSection draft={viewFixture()} />
    );
    expect(container.querySelectorAll(".tk-pill.is-ok")).toHaveLength(3);
    expect(container.querySelectorAll(".tk-pill.is-warn")).toHaveLength(1);
    expect(screen.getByText("妙手")).toBeInTheDocument();
    expect(screen.getByText("Canvas")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("汇率")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/sections.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `basic-settings-section.tsx`**

```tsx
// apps/web/src/components/settings/sections/basic-settings-section.tsx
import type { WorkspaceSettingsView } from "../../../../server/services/settings-service";
import { Field } from "../field";

export interface BasicSettingsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

const LOCALES = ["zh-CN", "th-TH", "en-US"] as const;
const CURRENCIES = ["CNY", "THB", "USD"] as const;
const MODES = ["mock", "live"] as const;

export function BasicSettingsSection({ draft, dirtyFields, onFieldChange }: BasicSettingsSectionProps): JSX.Element {
  return (
    <div className="tk-field-grid cols-2">
      <Field label="默认语言" help="新建商品时默认使用">
        <select value={draft.defaultLocale} onChange={(e) => onFieldChange("defaultLocale", e.target.value)}>
          {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
      <Field label="默认币种" help="利润换算的目标币种">
        <select value={draft.defaultCurrency} onChange={(e) => onFieldChange("defaultCurrency", e.target.value)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Provider 模式" help="mock = 仅本地模拟；live = 真实调用外部 API" isDirty={dirtyFields.has("externalAdapterMode")}>
        <select value={draft.externalAdapterMode} onChange={(e) => onFieldChange("externalAdapterMode", e.target.value as "mock" | "live")}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Worker 并发" help="同时处理的商品任务数" isDirty={dirtyFields.has("workerConcurrency")}>
        <input
          type="number"
          min={1}
          max={32}
          value={draft.workerConcurrency}
          onChange={(e) => onFieldChange("workerConcurrency", Number(e.target.value))}
        />
      </Field>
      <Field label="Canvas 每日上限" help="0 表示不限制" isDirty={dirtyFields.has("maxCanvasRunsPerDay")}>
        <input
          type="number"
          min={1}
          value={draft.maxCanvasRunsPerDay}
          onChange={(e) => onFieldChange("maxCanvasRunsPerDay", Number(e.target.value))}
        />
      </Field>
      <div className="tk-field tk-field--wide">
        <Field label="素材目录" help="Worker 写文件的绝对路径" isDirty={dirtyFields.has("assetRoot")}>
          <input
            type="text"
            value={draft.assetRoot}
            onChange={(e) => onFieldChange("assetRoot", e.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `pricing-formula-section.tsx`**

```tsx
// apps/web/src/components/settings/sections/pricing-formula-section.tsx
import type { WorkspaceSettingsView } from "../../../../server/services/settings-service";
import { Field } from "../field";

export interface PricingFormulaSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

function PctField(props: {
  label: string;
  help: string;
  path: string;
  value: string;
  dirty: boolean;
  onChange: (path: string, v: unknown) => void;
}): JSX.Element {
  return (
    <Field label={props.label} help={props.help} isDirty={props.dirty}>
      <input
        type="number"
        step="0.001"
        value={props.value}
        onChange={(e) => props.onChange(props.path, e.target.value)}
      />
    </Field>
  );
}

export function PricingFormulaSection({ draft, dirtyFields, onFieldChange }: PricingFormulaSectionProps): JSX.Element {
  const p = draft.pricingDefaults;
  return (
    <div className="tk-field-grid cols-3">
      <Field label="国内运费 CNY" help="每件商品分摊的国内发货成本" isDirty={dirtyFields.has("pricingDefaults.domesticShippingCny")}>
        <input type="number" step="0.01" value={p.domesticShippingCny} onChange={(e) => onFieldChange("pricingDefaults.domesticShippingCny", e.target.value)} />
      </Field>
      <Field label="跨境成本 CNY" help="头程 + 尾程物流综合" isDirty={dirtyFields.has("pricingDefaults.crossBorderCostCny")}>
        <input type="number" step="0.01" value={p.crossBorderCostCny} onChange={(e) => onFieldChange("pricingDefaults.crossBorderCostCny", e.target.value)} />
      </Field>
      <Field label="固定成本 THB" help="包装/标签等" isDirty={dirtyFields.has("pricingDefaults.fixedTargetCostThb")}>
        <input type="number" step="0.01" value={p.fixedTargetCostThb} onChange={(e) => onFieldChange("pricingDefaults.fixedTargetCostThb", e.target.value)} />
      </Field>
      <PctField label="平台费率" help="0.05 = 5%" path="pricingDefaults.platformFeeRate" value={p.platformFeeRate} dirty={dirtyFields.has("pricingDefaults.platformFeeRate")} onChange={onFieldChange} />
      <PctField label="支付费率" help="支付通道手续费" path="pricingDefaults.paymentFeeRate" value={p.paymentFeeRate} dirty={dirtyFields.has("pricingDefaults.paymentFeeRate")} onChange={onFieldChange} />
      <PctField label="目标利润率" help="售价中利润占比" path="pricingDefaults.targetProfitRate" value={p.targetProfitRate} dirty={dirtyFields.has("pricingDefaults.targetProfitRate")} onChange={onFieldChange} />
      <div className="tk-field tk-field--wide">
        <Field label="价格尾数" help="售价尾数；9 表示以 .9 结尾" isDirty={dirtyFields.has("pricingDefaults.ending")}>
          <input
            type="number"
            min={0}
            max={9}
            value={p.ending}
            onChange={(e) => onFieldChange("pricingDefaults.ending", e.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `provider-options-section.tsx`**

```tsx
// apps/web/src/components/settings/sections/provider-options-section.tsx
import type { WorkspaceSettingsView } from "../../../../server/services/settings-service";
import { Field } from "../field";

export interface ProviderOptionsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

export function ProviderOptionsSection({ draft, dirtyFields, onFieldChange }: ProviderOptionsSectionProps): JSX.Element {
  const p = draft.providerOptions;
  return (
    <div className="tk-field-grid cols-2">
      <Field label="Listing Provider" help='可选值：miaoshou / custom' isDirty={dirtyFields.has("providerOptions.listingProvider")}>
        <input type="text" value={p.listingProvider} onChange={(e) => onFieldChange("providerOptions.listingProvider", e.target.value)} />
      </Field>
      <Field label="Listing Model" help="Provider 对应的模型 ID" isDirty={dirtyFields.has("providerOptions.listingModel")}>
        <input type="text" value={p.listingModel} onChange={(e) => onFieldChange("providerOptions.listingModel", e.target.value)} />
      </Field>
      <div className="tk-field tk-field--wide">
        <Field label="Canvas 工作流" help="在 Canvas 后台创建的工作流 ID" isDirty={dirtyFields.has("providerOptions.canvasWorkflow")}>
          <input type="text" value={p.canvasWorkflow} onChange={(e) => onFieldChange("providerOptions.canvasWorkflow", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Implement `retry-policy-section.tsx`**

```tsx
// apps/web/src/components/settings/sections/retry-policy-section.tsx
import type { WorkspaceSettingsView } from "../../../../server/services/settings-service";
import { Field } from "../field";

export interface RetryPolicySectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

export function RetryPolicySection({ draft, dirtyFields, onFieldChange }: RetryPolicySectionProps): JSX.Element {
  const r = draft.retryPolicy;
  return (
    <div className="tk-field-grid cols-2">
      <Field label="最多尝试次数" help="含首次执行；1-20" isDirty={dirtyFields.has("retryPolicy.maxAttempts")}>
        <input type="number" min={1} max={20} value={r.maxAttempts} onChange={(e) => onFieldChange("retryPolicy.maxAttempts", Number(e.target.value))} />
      </Field>
      <Field label="首次重试等待（秒）" help="之后按指数退避" isDirty={dirtyFields.has("retryPolicy.initialDelaySeconds")}>
        <input type="number" min={1} value={r.initialDelaySeconds} onChange={(e) => onFieldChange("retryPolicy.initialDelaySeconds", Number(e.target.value))} />
      </Field>
    </div>
  );
}
```

- [ ] **Step 7: Implement `secret-status-section.tsx`**

```tsx
// apps/web/src/components/settings/sections/secret-status-section.tsx
import type { WorkspaceSettingsView } from "../../../../server/services/settings-service";
import { StatusPill } from "../status-pill";

export interface SecretStatusSectionProps {
  draft: WorkspaceSettingsView;
}

export function SecretStatusSection({ draft }: SecretStatusSectionProps): JSX.Element {
  const s = draft.secretStatus;
  return (
    <>
      <div className="tk-pill-row">
        <StatusPill name="妙手" envVars="MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET" configured={s.miaoshouConfigured} />
        <StatusPill name="Canvas" envVars="CANVAS_API_KEY" configured={s.canvasConfigured} />
        <StatusPill name="LLM" envVars="LLM_API_KEY" configured={s.llmConfigured} />
        <StatusPill name="汇率" envVars="EXCHANGE_RATE_API_KEY" configured={s.exchangeRateConfigured} />
      </div>
      <p style={{ margin: "14px 0 0", color: "var(--muted)", fontSize: "12px" }}>
        密钥不会进入浏览器或保存到本页面。在
        <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: "3px", margin: "0 4px" }}>
          ~/.local/share/tk-commerce-workbench/.env
        </code>
        中设置后，重启 Worker 进程即可生效。
      </p>
    </>
  );
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/sections.test.tsx
```

Expected: PASS, 8 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/settings/sections/ apps/web/src/components/settings/__tests__/sections.test.tsx
git commit -m "feat(settings): add five section components"
```

---

## Task 6: `settings-api.ts` — saveSettings + useSaveSettings hook

**Files:**
- Create: `apps/web/src/components/settings/settings-api.ts`
- Create: `apps/web/src/components/settings/__tests__/settings-api.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceSettingsView`, `FormData` (for legacy `saveSettings`)
- Produces:
  - `saveSettings(fetcher, current, data)` — preserved signature for backward compat (called by existing ops-editors.test.tsx test).
  - `patchSettings(fetcher, baseline, draft, draftFields) → Promise<{ ok: true, value } | { ok: false, status, error? }>` — new pure function.
  - `useSaveSettings() → { state, save }` — hook used by `SettingsWorkspace`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/__tests__/settings-api.test.tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { patchSettings, saveSettings, useSaveSettings } from "../settings-api";

function baselineFixture(): WorkspaceSettingsView {
  return {
    version: 1,
    defaultLocale: "zh-CN",
    defaultCurrency: "CNY",
    externalAdapterMode: "mock",
    workerConcurrency: 4,
    maxCanvasRunsPerDay: 50,
    assetRoot: "/tmp/assets",
    pricingDefaults: {
      domesticShippingCny: "8.50",
      crossBorderCostCny: "35.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.050",
      paymentFeeRate: "0.006",
      targetProfitRate: "0.20",
      ending: "9"
    },
    providerOptions: { listingProvider: "miaoshou", listingModel: "v3", canvasWorkflow: "wf-1" },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true },
    applicationNote: ""
  };
}

describe("saveSettings (legacy FormData path)", () => {
  it("posts the form values and expectedVersion to /api/v1/settings", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ...baselineFixture(), version: 2 });
    }) as unknown as typeof fetch;
    const form = new FormData();
    form.set("defaultLocale", "th-TH");
    form.set("defaultCurrency", "THB");
    form.set("externalAdapterMode", "mock");
    form.set("assetRoot", "/tmp/a");
    form.set("workerConcurrency", "4");
    form.set("maxCanvasRunsPerDay", "50");
    form.set("domesticShippingCny", "8.50");
    form.set("crossBorderCostCny", "35.00");
    form.set("fixedTargetCostThb", "10.00");
    form.set("platformFeeRate", "0.050");
    form.set("paymentFeeRate", "0.006");
    form.set("targetProfitRate", "0.20");
    form.set("ending", "9");
    form.set("listingProvider", "miaoshou");
    form.set("listingModel", "v3");
    form.set("canvasWorkflow", "wf-1");
    form.set("maxAttempts", "5");
    form.set("initialDelaySeconds", "30");

    const result = await saveSettings(fetcher, baselineFixture(), form);
    expect(result.ok).toBe(true);
    expect(bodies[0]).toMatchObject({
      expectedVersion: 1,
      defaultLocale: "th-TH"
    });
  });
});

describe("patchSettings", () => {
  it("POSTs the dirty draft fields with expectedVersion", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ...baselineFixture(), version: 2 });
    }) as unknown as typeof fetch;
    const baseline = baselineFixture();
    const draft = { ...baseline, defaultLocale: "th-TH" };
    const result = await patchSettings(fetcher, baseline, draft, new Set(["defaultLocale"]));
    expect(result.ok).toBe(true);
    expect(bodies[0]).toMatchObject({ expectedVersion: 1, defaultLocale: "th-TH" });
  });

  it("returns ok:false with status on non-2xx", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "x" }, { status: 409 })) as unknown as typeof fetch;
    const result = await patchSettings(fetcher, baselineFixture(), baselineFixture(), new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

describe("useSaveSettings", () => {
  it("starts idle and transitions to saving then success", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...baselineFixture(), version: 2 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    expect(result.current.state).toBe("idle");

    let promise: Promise<void>;
    act(() => {
      promise = result.current.save(baselineFixture(), { ...baselineFixture(), defaultLocale: "th-TH" }, new Set(["defaultLocale"]));
    });
    await waitFor(() => expect(result.current.state).toBe("saving"));
    await act(async () => { await promise!; });
    expect(result.current.state).toBe("idle");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("transitions to conflict on 409 and reports the actual version in error", async () => {
    const fetcher = vi.fn(async () => Response.json({ version: 7 }, { status: 409 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    await act(async () => {
      await result.current.save(baselineFixture(), baselineFixture(), new Set());
    });
    expect(result.current.state).toBe("conflict");
    expect(result.current.error).toContain("7");
  });

  it("transitions to error on 5xx", async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    await act(async () => {
      await result.current.save(baselineFixture(), baselineFixture(), new Set());
    });
    expect(result.current.state).toBe("error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-api.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `settings-api.ts`**

```ts
// apps/web/src/components/settings/settings-api.ts
"use client";

import { useCallback, useState } from "react";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export type SaveState = "idle" | "saving" | "conflict" | "error";

export type PatchResult =
  | { ok: true; value: WorkspaceSettingsView }
  | { ok: false; status: number; actualVersion?: number };

// ─── legacy FormData path (kept for ops-editors test compatibility) ────────
export async function saveSettings(
  fetcher: typeof fetch,
  current: WorkspaceSettingsView,
  data: FormData
): Promise<{ ok: true; value: WorkspaceSettingsView } | { ok: false; status: number }> {
  const response = await fetcher("/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: current.version,
      defaultLocale: data.get("defaultLocale"),
      defaultCurrency: data.get("defaultCurrency"),
      externalAdapterMode: data.get("externalAdapterMode"),
      assetRoot: data.get("assetRoot"),
      workerConcurrency: Number(data.get("workerConcurrency")),
      maxCanvasRunsPerDay: Number(data.get("maxCanvasRunsPerDay")),
      pricingDefaults: {
        domesticShippingCny: data.get("domesticShippingCny"),
        crossBorderCostCny: data.get("crossBorderCostCny"),
        fixedTargetCostThb: data.get("fixedTargetCostThb"),
        platformFeeRate: data.get("platformFeeRate"),
        paymentFeeRate: data.get("paymentFeeRate"),
        targetProfitRate: data.get("targetProfitRate"),
        ending: data.get("ending")
      },
      providerOptions: {
        listingProvider: data.get("listingProvider"),
        listingModel: data.get("listingModel"),
        canvasWorkflow: data.get("canvasWorkflow")
      },
      retryPolicy: {
        maxAttempts: Number(data.get("maxAttempts")),
        initialDelaySeconds: Number(data.get("initialDelaySeconds"))
      }
    })
  });
  return response.ok
    ? { ok: true, value: (await response.json()) as WorkspaceSettingsView }
    : { ok: false, status: response.status };
}

// ─── new JSON-path for controlled inputs ───────────────────────────────────
export async function patchSettings(
  fetcher: typeof fetch,
  baseline: WorkspaceSettingsView,
  draft: WorkspaceSettingsView,
  _dirtyFields: ReadonlySet<string>
): Promise<PatchResult> {
  const response = await fetcher("/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: baseline.version,
      defaultLocale: draft.defaultLocale,
      defaultCurrency: draft.defaultCurrency,
      externalAdapterMode: draft.externalAdapterMode,
      assetRoot: draft.assetRoot,
      workerConcurrency: draft.workerConcurrency,
      maxCanvasRunsPerDay: draft.maxCanvasRunsPerDay,
      pricingDefaults: draft.pricingDefaults,
      providerOptions: draft.providerOptions,
      retryPolicy: draft.retryPolicy
    })
  });
  if (response.ok) {
    return { ok: true, value: (await response.json()) as WorkspaceSettingsView };
  }
  let actualVersion: number | undefined;
  if (response.status === 409) {
    try {
      const body = (await response.json()) as { version?: number };
      actualVersion = body.version;
    } catch {
      // ignore parse failure
    }
  }
  return { ok: false, status: response.status, actualVersion };
}

// ─── React hook ────────────────────────────────────────────────────────────
export interface UseSaveSettingsOptions {
  fetcher?: typeof fetch;
}

export interface UseSaveSettingsResult {
  state: SaveState;
  error: string | null;
  save: (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>) => Promise<void>;
  reset: () => void;
}

export function useSaveSettings(options: UseSaveSettingsOptions = {}): UseSaveSettingsResult {
  const fetcher = options.fetcher ?? fetch;
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>) => {
      setState("saving");
      setError(null);
      const result = await patchSettings(fetcher, baseline, draft, dirtyFields);
      if (result.ok) {
        setState("idle");
        return;
      }
      if (result.status === 409) {
        setState("conflict");
        setError(result.actualVersion !== undefined ? `设置已被更新到版本 v${result.actualVersion}` : "设置已被其他页面更新");
        return;
      }
      setState("error");
      setError("保存失败，请稍后重试");
    },
    [fetcher]
  );

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
  }, []);

  return { state, error, save, reset };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-api.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/settings-api.ts apps/web/src/components/settings/__tests__/settings-api.test.tsx
git commit -m "feat(settings): add settings-api with saveSettings, patchSettings, useSaveSettings"
```

---

## Task 7: `save-bar.tsx` — sticky save bar

**Files:**
- Create: `apps/web/src/components/settings/save-bar.tsx`
- Create: `apps/web/src/components/settings/__tests__/save-bar.test.tsx`

**Interfaces:**
- Consumes: `state: SaveState`, `error: string | null`, `dirtyCount: number`, `version: number`, `onDiscard`, `onSave`
- Produces: `<SaveBar>` element; **null** when `state === "idle" && dirtyCount === 0`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/__tests__/save-bar.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SaveBar } from "../save-bar";

describe("SaveBar", () => {
  it("renders nothing when idle and no dirty fields", () => {
    const { container } = render(
      <SaveBar state="idle" error={null} dirtyCount={0} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows dirty count and version in dirty state", () => {
    render(
      <SaveBar state="idle" error={null} dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByText(/已修改/)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText(/v12/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeInTheDocument();
  });

  it("disables save button while saving", () => {
    render(
      <SaveBar state="saving" error={null} dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  });

  it("shows error state with red background and copy", () => {
    const { container } = render(
      <SaveBar state="error" error="保存失败，请稍后重试" dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(container.querySelector(".tk-save-bar.is-error")).not.toBeNull();
    expect(screen.getByText("保存失败，请稍后重试")).toBeInTheDocument();
  });

  it("shows conflict state with the actual version", () => {
    render(
      <SaveBar state="conflict" error="设置已被更新到版本 v7" dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByText(/v7/)).toBeInTheDocument();
  });

  it("invokes onDiscard and onSave callbacks", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <SaveBar state="idle" error={null} dirtyCount={1} version={12} onDiscard={onDiscard} onSave={onSave} />
    );
    await user.click(screen.getByRole("button", { name: "放弃修改" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/save-bar.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `save-bar.tsx`**

```tsx
// apps/web/src/components/settings/save-bar.tsx
import type { SaveState } from "./settings-api";

export interface SaveBarProps {
  state: SaveState;
  error: string | null;
  dirtyCount: number;
  version: number;
  onDiscard: () => void;
  onSave: () => void;
}

export function SaveBar({ state, error, dirtyCount, version, onDiscard, onSave }: SaveBarProps): JSX.Element | null {
  const visible = dirtyCount > 0 || state !== "idle";
  if (!visible) return null;
  const isError = state === "error" || state === "conflict";
  return (
    <div
      className={`tk-save-bar${isError ? " is-error" : ""}`}
      role="region"
      aria-label="保存栏"
    >
      <div className="tk-save-bar__status">
        <span className="dot" aria-hidden />
        {state === "conflict" ? (
          <span>{error ?? "设置已被其他页面更新"}</span>
        ) : state === "error" ? (
          <span>{error ?? "保存失败"}</span>
        ) : (
          <>
            已修改 <strong style={{ color: "var(--primary)", margin: "0 4px" }}>{dirtyCount}</strong> 项
            <span className="tk-save-bar__meta">当前版本 v{version}</span>
          </>
        )}
      </div>
      <div className="tk-save-bar__actions">
        <button type="button" className="tk-save-bar__btn--ghost" onClick={onDiscard} disabled={state === "saving"}>
          放弃修改
        </button>
        <button type="button" className="tk-save-bar__btn--primary" onClick={onSave} disabled={state === "saving"}>
          {state === "saving" ? "保存中…" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/save-bar.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/save-bar.tsx apps/web/src/components/settings/__tests__/save-bar.test.tsx
git commit -m "feat(settings): add sticky SaveBar component"
```

---

## Task 8: Add CSS classes to `globals.css`

**Files:**
- Modify: `apps/web/src/app/globals.css` (append at end)

- [ ] **Step 1: Append the settings CSS at the end of globals.css**

Append (do not modify existing styles):

```css
/* ─── Settings page redesign ────────────────────────────────────── */

.tk-info-banner {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 18px;
  margin-bottom: 20px;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
  background: #eff6ff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.tk-info-banner__icon {
  flex: 0 0 24px;
  width: 24px; height: 24px;
  display: grid; place-items: center;
  color: #2563eb;
  background: #fff;
  border-radius: 999px;
  font-size: 14px; font-weight: 800;
}
.tk-info-banner__body { min-width: 0; color: #1e3a8a; font-size: 13px; }
.tk-info-banner__body strong { color: #172033; font-weight: 700; }

.tk-settings-card {
  position: relative;
  padding: 0;
  border: 1px solid #d9e0e9;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  margin-bottom: 16px;
  overflow: hidden;
}
.tk-settings-card__head {
  display: grid;
  grid-template-columns: 4px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 16px 20px 14px;
  border-bottom: 1px solid #e7ebf0;
}
.tk-settings-card__accent {
  align-self: stretch;
  background: linear-gradient(180deg, #2563eb, #60a5fa);
  border-radius: 4px;
}
.tk-settings-card__title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.tk-settings-card__title h2 {
  margin: 0;
  color: #172033;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.005em;
}
.tk-settings-card__hint { color: #64748b; font-size: 12px; font-weight: 500; }
.tk-settings-card__dirty {
  color: #2563eb;
  font-size: 12px;
  font-weight: 600;
  background: #eff6ff;
  padding: 2px 8px;
  border-radius: 999px;
}
.tk-settings-card__body { padding: 18px 20px 20px; }

.tk-field { display: grid; gap: 6px; min-width: 0; }
.tk-field__label { color: #172033; font-size: 13px; font-weight: 600; }
.tk-field__control { position: relative; display: flex; align-items: center; }
.tk-field__control input,
.tk-field__control select {
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid #d9e0e9;
  border-radius: 8px;
  color: #172033;
  background: #fff;
  transition: border-color 120ms ease, box-shadow 120ms ease;
  appearance: none;
}
.tk-field__control select {
  background-image:
    linear-gradient(45deg, transparent 50%, #64748b 50%),
    linear-gradient(135deg, #64748b 50%, transparent 50%);
  background-position:
    calc(100% - 18px) 17px,
    calc(100% - 12px) 17px;
  background-size: 6px 6px, 6px 6px;
  background-repeat: no-repeat;
  padding-right: 32px;
}
.tk-field__control input:hover,
.tk-field__control select:hover { border-color: #94a3b8; }
.tk-field__control input:focus,
.tk-field__control select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}
.tk-field__control.is-dirty input,
.tk-field__control.is-dirty select {
  border-color: #2563eb;
  background: #eff6ff;
}
.tk-field__dirty-dot {
  position: absolute;
  right: 8px; top: 50%;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #2563eb;
  transform: translateY(-50%);
  pointer-events: none;
}
.tk-field__control select + .tk-field__dirty-dot { right: 32px; }
.tk-field__help { color: #64748b; font-size: 12px; line-height: 1.4; }
.tk-field__error { color: #b45309; font-size: 12px; }

.tk-field-grid { display: grid; gap: 16px 18px; }
.tk-field-grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tk-field-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.tk-field-grid.cols-2 > .tk-field--wide,
.tk-field-grid.cols-3 > .tk-field--wide { grid-column: 1 / -1; }
@media (max-width: 760px) {
  .tk-field-grid.cols-2,
  .tk-field-grid.cols-3 { grid-template-columns: 1fr; }
}

.tk-pill-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 760px) {
  .tk-pill-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.tk-pill {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  transition: transform 120ms ease, box-shadow 120ms ease;
  cursor: default;
}
.tk-pill:hover { transform: translateY(-1px); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04); }
.tk-pill__icon {
  display: grid; place-items: center;
  width: 24px; height: 24px;
  border-radius: 999px;
  font-size: 14px; font-weight: 800;
}
.tk-pill__body { min-width: 0; }
.tk-pill__name { font-size: 13px; font-weight: 700; color: #172033; }
.tk-pill__env {
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: #64748b;
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-pill.is-ok { background: #d1fae5; border-color: #a7f3d0; }
.tk-pill.is-ok .tk-pill__icon { background: #10b981; color: #fff; }
.tk-pill.is-warn { background: #fef3c7; border-color: #fde68a; }
.tk-pill.is-warn .tk-pill__icon { background: #f59e0b; color: #fff; }

.tk-save-bar {
  position: fixed;
  left: 16px; right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 18px;
  border: 1px solid #d9e0e9;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.16);
  z-index: 10;
}
.tk-save-bar__status { display: inline-flex; align-items: center; gap: 10px; color: #172033; font-size: 13px; font-weight: 600; }
.tk-save-bar__status .dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #2563eb;
  box-shadow: 0 0 0 4px #eff6ff;
}
.tk-save-bar__meta {
  color: #64748b; font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.tk-save-bar__actions { display: inline-flex; gap: 8px; }
.tk-save-bar__btn--ghost { background: transparent; border-color: #d9e0e9; }
.tk-save-bar__btn--primary {
  background: #2563eb; border-color: #2563eb; color: #fff;
}
.tk-save-bar__btn--primary:hover:not(:disabled) {
  background: #1d4ed8; border-color: #1d4ed8;
}
.tk-save-bar.is-error { background: #fee2e2; border-color: #fca5a5; }
.tk-save-bar.is-error .tk-save-bar__status .dot {
  background: #991b1b;
  box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.15);
}

.tk-toast {
  position: fixed;
  right: 24px; bottom: 96px;
  padding: 12px 16px;
  border: 1px solid #a7f3d0;
  background: #d1fae5;
  color: #047857;
  border-radius: 10px;
  font-size: 13px; font-weight: 600;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
  display: inline-flex; align-items: center; gap: 8px;
  z-index: 11;
}
@keyframes tk-toast-in {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.tk-toast { animation: tk-toast-in 180ms ease-out; }
```

- [ ] **Step 2: Verify lint passes**

```bash
pnpm --filter @tk/web lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "feat(settings): add tk-settings-* CSS classes"
```

---

## Task 9: `settings-workspace.tsx` — top-level orchestrator

**Files:**
- Create: `apps/web/src/components/settings/settings-workspace.tsx`
- Create: `apps/web/src/components/settings/__tests__/settings-workspace.test.tsx`

**Interfaces:**
- Consumes: `initial: WorkspaceSettingsView`, optional `fetcher` (defaults to `fetch`)
- Produces: full settings page with state, dirty tracking, save bar, toast, ⌘+S handler, beforeunload guard

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/__tests__/settings-workspace.test.tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { SettingsWorkspace } from "../settings-workspace";

function baseline(): WorkspaceSettingsView {
  return {
    version: 12,
    defaultLocale: "zh-CN",
    defaultCurrency: "CNY",
    externalAdapterMode: "mock",
    workerConcurrency: 4,
    maxCanvasRunsPerDay: 50,
    assetRoot: "/tmp/assets",
    pricingDefaults: {
      domesticShippingCny: "8.50",
      crossBorderCostCny: "35.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.050",
      paymentFeeRate: "0.006",
      targetProfitRate: "0.20",
      ending: "9"
    },
    providerOptions: { listingProvider: "miaoshou", listingModel: "v3", canvasWorkflow: "wf-1" },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: false },
    applicationNote: ""
  };
}

describe("SettingsWorkspace", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
    removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("renders all five cards with the initial values and no save bar", () => {
    render(<SettingsWorkspace initial={baseline()} />);
    expect(screen.getByText("基础设置")).toBeInTheDocument();
    expect(screen.getByText("定价公式")).toBeInTheDocument();
    expect(screen.getByText("Provider 默认值")).toBeInTheDocument();
    expect(screen.getByText("重试策略")).toBeInTheDocument();
    expect(screen.getByText("密钥配置状态")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("shows save bar with dirty count after editing one field", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspace initial={baseline()} />);
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    const saveBar = await screen.findByRole("region", { name: "保存栏" });
    expect(saveBar).toHaveTextContent(/已修改/);
    expect(saveBar).toHaveTextContent(/1/);
    expect(saveBar).toHaveTextContent(/v12/);
  });

  it("discard reverts all fields and hides the save bar", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspace initial={baseline()} />);
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "en-US");
    await user.clear(screen.getByDisplayValue("9"));
    await user.type(screen.getByLabelText("价格尾数"), "5");

    const saveBar = screen.getByRole("region", { name: "保存栏" });
    expect(saveBar).toHaveTextContent(/3/);

    await user.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(screen.getByDisplayValue("zh-CN")).toBeInTheDocument();
    expect(screen.getByDisplayValue("9")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("PATCH on save returns 200 → bar hides, version updates, toast appears", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({ ...baseline(), version: 13 })) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "保存栏" })).toBeNull();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/已保存/)).toBeInTheDocument();
  });

  it("PATCH 409 keeps the save bar visible and shows conflict copy", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({ version: 7 }, { status: 409 })) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "保存栏" })).toHaveTextContent(/v7/);
    });
  });

  it("PATCH 500 keeps draft and shows error copy", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "保存栏" })).toHaveTextContent(/保存失败/);
    });
    expect(screen.getByDisplayValue("th-TH")).toBeInTheDocument();
  });

  it("⌘+S triggers save when dirty and idle", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...baseline(), version: 13 })) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    await userEvent.setup().selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    act(() => {
      fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
  });

  it("⌘+S in idle state does NOT trigger save", () => {
    const fetcher = vi.fn(async () => Response.json(baseline())) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("registers a beforeunload listener only while dirty", async () => {
    const user = userEvent.setup();
    render(<SettingsWorkspace initial={baseline()} />);
    expect(addEventListenerSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
    await user.selectOptions(screen.getByDisplayValue("zh-CN"), "th-TH");
    expect(addEventListenerSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-workspace.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `settings-workspace.tsx`**

```tsx
// apps/web/src/components/settings/settings-workspace.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { computeDirtyFields, setNestedField } from "./dirty";
import { InfoBanner } from "./info-banner";
import { SaveBar } from "./save-bar";
import { BasicSettingsSection } from "./sections/basic-settings-section";
import { PricingFormulaSection } from "./sections/pricing-formula-section";
import { ProviderOptionsSection } from "./sections/provider-options-section";
import { RetryPolicySection } from "./sections/retry-policy-section";
import { SecretStatusSection } from "./sections/secret-status-section";
import { SettingsCard } from "./settings-card";
import { useSaveSettings, type SaveState } from "./settings-api";

export interface SettingsWorkspaceProps {
  initial: WorkspaceSettingsView;
  fetcher?: typeof fetch;
}

interface ToastState {
  kind: "success" | "error";
  message: string;
  key: number;
}

export function SettingsWorkspace({ initial, fetcher }: SettingsWorkspaceProps): JSX.Element {
  const [baseline, setBaseline] = useState<WorkspaceSettingsView>(initial);
  const [draft, setDraft] = useState<WorkspaceSettingsView>(initial);
  const [toast, setToast] = useState<ToastState | null>(null);
  const saveHook = useSaveSettings({ fetcher });
  const prevSaveStateRef = useRef<SaveState>("idle");

  const dirtyFields = useMemo(() => computeDirtyFields(baseline, draft), [baseline, draft]);
  const dirtyCount = dirtyFields.size;

  const handleFieldChange = useCallback((dottedPath: string, value: unknown) => {
    setDraft((prev) => setNestedField(prev, dottedPath, value));
  }, []);

  const handleDiscard = useCallback(() => {
    setDraft(baseline);
    saveHook.reset();
    setToast(null);
  }, [baseline, saveHook]);

  const handleSave = useCallback(async () => {
    if (dirtyCount === 0) return;
    await saveHook.save(baseline, draft, dirtyFields);
  }, [baseline, draft, dirtyCount, dirtyFields, saveHook]);

  // Detect successful save (saving → idle with no error) and advance baseline + show toast.
  useEffect(() => {
    if (prevSaveStateRef.current === "saving" && saveHook.state === "idle" && saveHook.error === null) {
      setBaseline(draft);
      setToast({ kind: "success", message: `已保存 · 版本 v${draft.version}`, key: Date.now() });
    }
    prevSaveStateRef.current = saveHook.state;
  }, [saveHook.state, saveHook.error, draft]);

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ⌘/Ctrl+S to save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && dirtyCount > 0 && saveHook.state !== "saving") {
        e.preventDefault();
        void handleSave();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirtyCount, saveHook.state, handleSave]);

  // beforeunload guard when dirty
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // Per-card dirty counts
  const basicDirty = ["defaultLocale", "defaultCurrency", "externalAdapterMode", "workerConcurrency", "maxCanvasRunsPerDay", "assetRoot"]
    .filter((k) => dirtyFields.has(k)).length;
  const pricingDirty = ["domesticShippingCny", "crossBorderCostCny", "fixedTargetCostThb", "platformFeeRate", "paymentFeeRate", "targetProfitRate", "ending"]
    .filter((k) => dirtyFields.has(`pricingDefaults.${k}`)).length;
  const providerDirty = ["listingProvider", "listingModel", "canvasWorkflow"]
    .filter((k) => dirtyFields.has(`providerOptions.${k}`)).length;
  const retryDirty = ["maxAttempts", "initialDelaySeconds"]
    .filter((k) => dirtyFields.has(`retryPolicy.${k}`)).length;

  return (
    <>
      <InfoBanner />

      <SettingsCard title="基础设置" hint="新建商品和 Worker 启动时使用的默认值" ariaLabel="基础设置" dirtyCount={basicDirty}>
        <BasicSettingsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="定价公式" hint="影响每个商品的售价建议" ariaLabel="定价公式" dirtyCount={pricingDirty}>
        <PricingFormulaSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="Provider 默认值" hint="非密钥 Provider 的默认配置" ariaLabel="Provider 默认值" dirtyCount={providerDirty}>
        <ProviderOptionsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="重试策略" hint="妙手 / Canvas / LLM 暂时不可用时的行为" ariaLabel="重试策略" dirtyCount={retryDirty}>
        <RetryPolicySection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="密钥配置状态" hint="密钥不会进入浏览器或保存到本页面" ariaLabel="密钥配置状态">
        <SecretStatusSection draft={draft} />
      </SettingsCard>

      <SaveBar
        state={saveHook.state}
        error={saveHook.error}
        dirtyCount={dirtyCount}
        version={baseline.version}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />

      {toast ? (
        <output className="tk-toast" role="status" key={toast.key}>
          <span aria-hidden>✓</span>
          {toast.message}
        </output>
      ) : null}
    </>
  );
}
```

> **Note:** `prevSaveStateRef` tracks the previous save state so we can detect
> the transition `saving → idle` and fire the success side-effect (advance
> baseline + toast) exactly once. Without the ref, the hook starts at `idle`
> and never re-enters the success branch.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tk/web test -- src/components/settings/__tests__/settings-workspace.test.tsx
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/settings-workspace.tsx apps/web/src/components/settings/__tests__/settings-workspace.test.tsx
git commit -m "feat(settings): add SettingsWorkspace orchestrator"
```

---

## Task 10: Wire `page.tsx` and migrate `operations-editors.test.tsx`

**Files:**
- Modify: `apps/web/src/app/settings/page.tsx`
- Modify: `apps/web/src/components/operations-editors.test.tsx`
- Delete: `apps/web/src/components/settings/settings-editor.tsx`

- [ ] **Step 1: Update `page.tsx`**

Replace entire file content:

```tsx
import { getServerServices } from "../../server/composition";
import { SettingsWorkspace } from "../../components/settings/settings-workspace";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await (await getServerServices()).settings.get();
  return <SettingsWorkspace initial={settings} />;
}
```

- [ ] **Step 2: Update `operations-editors.test.tsx` import**

In `apps/web/src/components/operations-editors.test.tsx`, change:

```ts
import { saveSettings } from "./settings/settings-editor";
```

to:

```ts
import { saveSettings } from "./settings/settings-api";
```

Leave the rest of the file unchanged.

- [ ] **Step 3: Delete `settings-editor.tsx`**

```bash
git rm apps/web/src/components/settings/settings-editor.tsx
```

- [ ] **Step 4: Run all settings tests**

```bash
pnpm --filter @tk/web test -- src/components/settings/ src/components/operations-editors.test.tsx
```

Expected: all settings tests + operations-editors.test.tsx PASS.

- [ ] **Step 5: Run lint, typecheck, build**

```bash
pnpm --filter @tk/web lint
pnpm --filter @tk/web typecheck
pnpm --filter @tk/web build
```

Expected: no errors.

- [ ] **Step 6: Restart runtime and manually smoke**

```bash
# stop existing server (idempotent if not running)
node scripts/local-production-runtime.mjs stop
# rebuild web bundle (required because page.tsx changed)
pnpm --filter @tk/web build
# start
node scripts/local-production-runtime.mjs start
# open browser
explorer.exe http://127.0.0.1:3000/settings
```

Walk through the manual smoke checklist from the spec:

- [ ] All five cards render with current values
- [ ] No save bar visible at idle
- [ ] Change `defaultLocale` → save bar appears with "1 项已改"; dot appears next to the field; card title gets "（已改）" tag — **note**: the badge is implemented as `已改 1 项` next to the card title; verify that text is visible
- [ ] Click "放弃修改" → bar disappears; field reverts
- [ ] Change a pricing field, click "保存设置" → toast appears; bar hides; version increments in header (`v13`)
- [ ] Open `/settings` in two tabs. Tab A saves. Tab B edits a different value and saves → 409 → red bar with refresh actions
- [ ] `⌘+S` (or `Ctrl+S` on Linux) while focused on a field → triggers save if dirty
- [ ] Resize to < 1024px → cards collapse to single column
- [ ] All secret pills show correct configured / not-configured state

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/settings/page.tsx apps/web/src/components/operations-editors.test.tsx
git commit -m "refactor(settings): wire SettingsWorkspace and migrate legacy saveSettings import"
```

---

## Task 11: Final verification gate

**Files:** none modified — verification only.

- [ ] **Step 1: Run full web test suite**

```bash
pnpm --filter @tk/web test
```

Expected: all tests PASS.

- [ ] **Step 2: Run lint**

```bash
pnpm --filter @tk/web lint
```

Expected: no errors, no warnings (`--max-warnings=0`).

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @tk/web typecheck
```

Expected: exit 0.

- [ ] **Step 4: Run build**

```bash
pnpm --filter @tk/web build
```

Expected: build succeeds, exit 0.

- [ ] **Step 5: Run broader test suite (workspace root)**

```bash
pnpm test
```

Expected: all packages PASS.

- [ ] **Step 6: Confirm git status is clean (committed)**

```bash
git status
```

Expected: working tree clean (or only the untracked spec/prototype files which are design artifacts).

- [ ] **Step 7: Final report to user**

Summarize:

- Number of files created / modified / deleted
- Total test count delta
- Lint / typecheck / build results
- Manual smoke checklist status
- Next steps (if any)