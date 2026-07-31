# Headless Image Generation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Infinite-Canvas in the production image-cleaning path with persistent, category-aware prompt planning and independently retryable image-generation slots inside TK Commerce Workbench.

**Architecture:** The Web process creates an immutable generation batch from local source assets and a frozen template version. The existing PostgreSQL worker first plans exactly M prompts, then schedules one durable job per slot; each slot reconciles its own provider request and archives its result locally before becoming successful. Product review and Miaoshou writeback consume local asset IDs, so Canvas is no longer an execution or hosting dependency.

**Tech Stack:** Node.js 22, TypeScript 5.9, pnpm workspace, Next.js App Router, PostgreSQL/`pg`, Vitest, Testing Library, Playwright, Zod, existing leased worker and content-addressed asset store.

## Global Constraints

- Keep Infinite-Canvas available only as a separate development experiment; do not copy its runtime implementation.
- Do not introduce a standalone Python service or a node-graph editor.
- Input count is exactly 1–6; output count is exactly 1–8.
- Every batch freezes product facts, selected local asset IDs, category, template version, provider/model parameters, and requested output count.
- Editing an active template creates a draft version; activation affects future batches only.
- Planning and each output slot are separate durable jobs with a default maximum of three attempts.
- A successful slot must never be regenerated because a sibling failed.
- A slot is successful only after its output has been validated and stored in the local content-addressed archive.
- Partial successful output is reviewable, order-preserving, and publishable after explicit approval.
- Daily UI copy is Chinese and does not expose provider names, raw prompts, task IDs, or raw provider errors.
- Miaoshou writeback must use approved local assets through a non-Canvas publishing transport.
- Preserve all existing source assets, generated assets, approvals, audit events, and completed Canvas runs during migration.
- Before execution, use `superpowers:using-git-worktrees`; the current branch contains unrelated uncommitted UI/startup-script changes that must not be mixed into task commits.

---

## File Structure

### Contracts and pure domain rules

- Create `packages/contracts/src/image-generation.ts`: immutable template, batch, slot, planner, provider, and command types.
- Modify `packages/contracts/src/jobs.ts`: add `image_prompt_plan` and `image_generate_slot` durable job payloads.
- Modify `packages/contracts/src/ports.ts`: add `ImagePromptPlannerPort` and `ImageGenerationPort` boundaries.
- Modify `packages/contracts/src/read-models.ts`: expose generation/template projections to Web.
- Create `packages/domain/src/image-generation/validate-recipe.ts`: count and role guardrails.
- Create `packages/domain/src/image-generation/validate-plan.ts`: strict planner response validation.
- Create `packages/domain/src/image-generation/resolve-template.ts`: category-parent fallback.
- Create `packages/domain/src/image-generation/infer-category.ts`: deterministic source-fact mapping to the initial internal categories.
- Create `packages/domain/src/image-generation/slot-business-key.ts`: stable paid-call identity.

### Persistence

- Modify `packages/db/src/migrations/0000_initial.ts`: add template lifecycle fields and generation batch/slot tables.
- Modify `packages/db/src/schema/index.ts`: mirror the new tables and row shapes.
- Create `packages/db/src/repositories/image-generation-repository.ts`: transactional batch creation, plan persistence, slot transitions, and projections.
- Modify `packages/db/src/index.ts`: export the repository.
- Add repository integration coverage to `packages/db/src/integration/repositories.integration.test.ts`.

### External adapters and worker

- Create `packages/adapters/src/image-generation/openai-image-planner.ts`: strict multimodal planning request.
- Create `packages/adapters/src/image-generation/openai-compatible-image-provider.ts`: accept either a synchronous image URL or an asynchronous task ID for one slot.
- Create `packages/adapters/src/image-generation/provider-errors.ts`: safe retry classification.
- Modify adapter factory, fake ports, config, and exports to compose the new ports without exposing secrets.
- Create `apps/worker/src/handlers/plan-images.ts`: validate and persist exactly M prompts, then enqueue M slots.
- Create `apps/worker/src/handlers/generate-image-slot.ts`: reconcile, download, validate, archive, and persist one slot.
- Modify worker composition/entry and job recovery rules to register both handlers.

### Web services, API, and UI

- Create `apps/web/src/server/services/image-generation-service.ts`: start/retry/exclude/accept commands.
- Create API routes under `apps/web/src/app/api/v1/products/[productId]/image-generations/`.
- Modify product projection to include current batch, slots, original local images, and processed local images.
- Create `apps/web/src/components/products/image-generation-panel.tsx`: compact generation and progress panel.
- Expand template service/API/manager for draft, activate, archive, restore, and prompt-only test.
- Modify final review so accepted successful slot asset IDs can enter final image order.

### Cutover and acceptance

- Modify settings/config/read models to replace Canvas production readiness with planner/image-provider readiness.
- Keep old Canvas rows readable but stop creating new `canvas_generate` jobs after the feature switch.
- Extend E2E fixtures for counts, partial success, restart recovery, and Canvas-off Miaoshou writeback.

---

### Task 1: Define Generation Contracts and Pure Validation

**Files:**
- Create: `packages/contracts/src/image-generation.ts`
- Modify: `packages/contracts/src/jobs.ts`
- Modify: `packages/contracts/src/ports.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/domain/src/image-generation/validate-recipe.ts`
- Create: `packages/domain/src/image-generation/validate-plan.ts`
- Create: `packages/domain/src/image-generation/resolve-template.ts`
- Create: `packages/domain/src/image-generation/infer-category.ts`
- Create: `packages/domain/src/image-generation/slot-business-key.ts`
- Create: `packages/domain/src/image-generation/image-generation.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `ImageGenerationRecipeV1`, `PlannedImagePromptV1`, `ImagePromptPlannerPort`, `ImageGenerationPort`, `validateRecipe`, `validatePlannedPrompts`, `inferImageCategory`, `resolveCategoryTemplate`, and `imageSlotBusinessKey`.
- Consumes: existing branded string IDs and `ExternalFailure` conventions from `@tk/contracts`.

- [ ] **Step 1: Write failing domain tests for all non-negotiable rules**

```ts
import { describe, expect, it } from "vitest";
import { imageSlotBusinessKey } from "./slot-business-key.js";
import { inferImageCategory } from "./infer-category.js";
import { resolveCategoryTemplate } from "./resolve-template.js";
import { validatePlannedPrompts } from "./validate-plan.js";
import { validateRecipe } from "./validate-recipe.js";

describe("headless image-generation rules", () => {
  it.each([[0, 1], [7, 1], [1, 0], [1, 9]])("rejects input=%i output=%i", (inputCount, outputCount) => {
    expect(() => validateRecipe({ inputCount, outputCount, roles: ["hero"] })).toThrow("image_generation_count_out_of_range");
  });
  it("requires exactly one contiguous prompt per requested slot", () => {
    expect(() => validatePlannedPrompts({ requestedCount: 2, mandatoryFacts: ["red bow"], prompts: [
      { slot: 1, role: "hero", prompt: "Show red bow", mustPreserve: ["red bow"], forbidden: [] },
      { slot: 1, role: "detail", prompt: "Detail red bow", mustPreserve: ["red bow"], forbidden: [] }
    ] })).toThrow("image_plan_slots_invalid");
  });
  it("falls back from child to the closest active parent", () => {
    expect(resolveCategoryTemplate("women.hat.sun", [
      { templateId: "generic", categoryKey: "generic", activeVersionId: "generic-v1" },
      { templateId: "hat", categoryKey: "women.hat", activeVersionId: "hat-v2" }
    ])?.templateId).toBe("hat");
  });
  it.each([
    ["蕾丝蝴蝶结大帽檐遮阳草帽", "women.hat"],
    ["复古珍珠耳环", "jewelry"],
    ["宽松棉麻衬衫", "apparel"],
    ["桌面收纳盒", "generic"]
  ])("infers %s as %s", (sourceTitle, expected) => {
    expect(inferImageCategory({ sourceTitle, sourceAttributes: [] })).toBe(expected);
  });
  it("creates a deterministic paid-call key", () => {
    expect(imageSlotBusinessKey({ revisionId: "rev_1", templateVersionId: "tv_2", slot: 3, promptHash: "abc" }))
      .toBe("rev_1:tv_2:3:abc");
  });
});
```

- [ ] **Step 2: Run the test and verify the modules are missing**

Run: `pnpm --filter @tk/domain test -- src/image-generation/image-generation.test.ts`

Expected: FAIL with module-resolution errors for the four new domain modules.

- [ ] **Step 3: Add exact contract types and job payloads**

```ts
export type ImageGenerationSlotStatus = "waiting_for_plan" | "queued" | "submitting" | "polling" | "archiving" | "succeeded" | "failed" | "excluded";

export type PlannedImagePromptV1 = Readonly<{
  slot: number;
  role: string;
  prompt: string;
  mustPreserve: string[];
  forbidden: string[];
}>;

export interface ImagePromptPlannerPort {
  plan(input: Readonly<{ productFacts: Record<string, unknown>; localImagePaths: string[]; recipe: ImageGenerationRecipeV1; requestedOutputCount: number; idempotencyKey: IdempotencyKey }>): Promise<{ prompts: PlannedImagePromptV1[] }>;
}

export interface ImageGenerationPort {
  submit(input: Readonly<{ prompt: PlannedImagePromptV1; referenceImagePaths: string[]; parameters: Record<string, unknown>; idempotencyKey: IdempotencyKey }>): Promise<{ kind: "completed"; outputUrl: string } | { kind: "accepted"; remoteTaskId: string }>;
  fetch(input: Readonly<{ remoteTaskId: string }>): Promise<{ state: "pending" } | { state: "succeeded"; outputUrl: string } | { state: "failed"; failure: ExternalFailure }>;
}
```

Add `image_prompt_plan` payload `{ version: 1; batchId: string }` and `image_generate_slot` payload `{ version: 1; batchId: string; slotId: string }` to `JobKind`, `JOB_KIND_VERSION`, and the job union.

- [ ] **Step 4: Implement minimal validators, fallback, and business-key generation**

```ts
export function validateRecipe(input: { inputCount: number; outputCount: number; roles: string[] }) {
  if (!Number.isInteger(input.inputCount) || input.inputCount < 1 || input.inputCount > 6 ||
      !Number.isInteger(input.outputCount) || input.outputCount < 1 || input.outputCount > 8) {
    throw new Error("image_generation_count_out_of_range");
  }
  if (input.roles.length < input.outputCount) throw new Error("image_generation_roles_insufficient");
  return Object.freeze({ ...input, roles: input.roles.slice(0, input.outputCount) });
}
```

`validatePlannedPrompts` must reject non-contiguous/duplicate slots, count mismatch, empty prompts, prompts over 4,000 characters, any missing mandatory fact, any template-forbidden phrase, and material/certification/performance/price/endorsement claims that are absent from the frozen verified facts. `inferImageCategory` must normalize captured title/category/attributes and map initial hat, jewelry, and apparel keywords to `women.hat`, `jewelry`, and `apparel`, otherwise `generic`. `resolveCategoryTemplate` must try the exact dot-delimited category, then parents, then `generic`.

- [ ] **Step 5: Run contract/domain tests and typecheck**

Run: `pnpm --filter @tk/domain test -- src/image-generation/image-generation.test.ts && pnpm --filter @tk/contracts typecheck && pnpm --filter @tk/domain typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add packages/contracts/src packages/domain/src
git commit -m "feat: define headless image generation contracts"
```

### Task 2: Persist Template Versions, Batches, and Independent Slots

**Files:**
- Modify: `packages/db/src/migrations/0000_initial.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`

**Interfaces:**
- Consumes: `ImageGenerationRecipeV1`, `PlannedImagePromptV1`, and `imageSlotBusinessKey` from Task 1.
- Produces: `ImageGenerationRepository.createBatch`, `loadPlanningContext`, `savePlanAndQueueSlots`, `loadSlotExecution`, `saveRemoteTask`, `markSlotSucceeded`, `markSlotFailed`, `excludeSlot`, `acceptPartial`, and `getProductProjection`.

- [ ] **Step 1: Write failing integration tests for atomicity and slot independence**

```ts
it("creates batch, planner job, and requested slots atomically and idempotently", async () => {
  const first = await repository.createBatch(fixtureStart({ idempotencyKey: "start:rev_1:abc", outputCount: 3 }));
  const second = await repository.createBatch(fixtureStart({ idempotencyKey: "start:rev_1:abc", outputCount: 3 }));
  expect(second.batchId).toBe(first.batchId);
  expect(await countRows(pool, "image_generation_slots", first.batchId)).toBe(3);
  expect(await countJobs(pool, "image_prompt_plan", first.batchId)).toBe(1);
});

it("keeps successful siblings unchanged when one slot fails", async () => {
  await repository.markSlotSucceeded("slot_1", fixtureArchivedAsset("asset_a"), fence);
  await repository.markSlotFailed("slot_2", safeFailure("provider_timeout"), fence);
  expect((await repository.getProductProjection("prod_1")).slots.map((slot) => slot.status))
    .toEqual(["succeeded", "failed", "queued"]);
});
```

- [ ] **Step 2: Run DB integration tests and verify missing tables/repository**

Run: `pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: FAIL because `ImageGenerationRepository` and generation tables do not exist.

- [ ] **Step 3: Add migration tables and constraints**

```sql
ALTER TABLE templates ADD COLUMN IF NOT EXISTS category_key TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS parent_category_key TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS recipe JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS templates_one_active_version
  ON templates(template_key) WHERE lifecycle_state = 'active';

CREATE TABLE IF NOT EXISTS image_generation_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  selected_asset_ids JSONB NOT NULL,
  requested_output_count INTEGER NOT NULL CHECK (requested_output_count BETWEEN 1 AND 8),
  category_key TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  recipe_snapshot JSONB NOT NULL,
  product_facts_snapshot JSONB NOT NULL,
  product_facts_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planning',
  accepted_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS image_generation_slots (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES image_generation_batches(id) ON DELETE CASCADE,
  slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 8),
  role TEXT NOT NULL,
  prompt JSONB,
  prompt_hash TEXT,
  business_key TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'waiting_for_plan',
  attempt INTEGER NOT NULL DEFAULT 0,
  remote_task_id TEXT,
  remote_output_url TEXT,
  archived_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  error JSONB,
  excluded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id, slot_number)
);
```

- [ ] **Step 4: Implement transactional repository operations with fenced terminal writes**

`createBatch` must lock the selected template version, verify every selected asset is `ready`, insert the batch and slots, and insert one `image_prompt_plan` job in the same transaction. `savePlanAndQueueSlots` must update only `waiting_for_plan` slots and enqueue one `image_generate_slot` job per slot using `business_key` uniqueness. Terminal slot writes must include the existing lease fence in their `WHERE` path or execute through the fenced worker repository callback.

- [ ] **Step 5: Run migration and repository integration tests**

Run: `pnpm db:migrate && pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: PASS, including idempotent re-running of the migration.

- [ ] **Step 6: Commit persistence**

```bash
git add packages/db/src
git commit -m "feat: persist image generation batches and slots"
```

### Task 3: Implement Template Lifecycle and Category Resolution APIs

**Files:**
- Modify: `apps/web/src/server/services/template-service.ts`
- Create: `apps/web/src/server/services/template-service.test.ts`
- Modify: `apps/web/src/app/api/v1/templates/route.ts`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/activate/route.ts`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/archive/route.ts`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/restore/route.ts`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/duplicate/route.ts`
- Modify: `packages/contracts/src/read-models.ts`

**Interfaces:**
- Consumes: recipe/count validation and persisted template lifecycle fields from Tasks 1–2.
- Produces: `TemplateService.createDraft`, `updateDraft`, `activate`, `archive`, `restoreVersion`, `duplicate`, `resolveActive`, and expanded `ImageGenerationTemplateViewV1`.

- [ ] **Step 1: Write failing service tests for immutable activation and rollback**

```ts
it("editing an active version appends a draft and leaves active unchanged", async () => {
  const active = await service.activate("template_hat", 1);
  const draft = await service.updateDraft({ templateId: "template_hat", expectedVersion: 1, visualDirection: "Beach vacation" });
  expect(active.lifecycleState).toBe("active");
  expect(draft).toMatchObject({ version: 2, lifecycleState: "draft" });
  expect((await service.resolveActive("women.hat")).version).toBe(1);
});

it("restores an old version by copying it to a new draft", async () => {
  const restored = await service.restoreVersion("template_hat", 1);
  expect(restored).toMatchObject({ version: 3, lifecycleState: "draft" });
});

it("duplicates into a new draft family without changing the source", async () => {
  const copy = await service.duplicate("template_hat", 1);
  expect(copy).toMatchObject({ version: 1, lifecycleState: "draft", name: "Women's hat 副本" });
  expect(copy.templateId).not.toBe("template_hat");
  expect((await service.resolveActive("women.hat")).templateId).toBe("template_hat");
});
```

- [ ] **Step 2: Run the service test and verify lifecycle methods are missing**

Run: `pnpm --filter @tk/web test -- src/server/services/template-service.test.ts`

Expected: FAIL with missing lifecycle methods.

- [ ] **Step 3: Expand the service record and transaction methods**

Use recipe fields `inputCounts`, `outputCounts`, `mustPreserve`, `visualDirection`, `forbidden`, `roles`, `planner`, and `imageProvider`. `activate` must transactionally archive the previously active version and activate the selected draft; `restoreVersion` must copy an immutable historical row into `max(version)+1` as `draft`.

`duplicate(templateId, version)` creates a new template family at version 1 with lifecycle `draft`, copies the immutable recipe, appends `副本` to the name, and leaves the source family unchanged.

- [ ] **Step 4: Add strict API schemas and mutation handlers**

```ts
const Counts = z.strictObject({ default: z.number().int(), min: z.number().int(), max: z.number().int() });
const Recipe = z.strictObject({
  inputCounts: Counts.refine((v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 6),
  outputCounts: Counts.refine((v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 8),
  mustPreserve: z.array(z.string().trim().min(1).max(300)).max(50),
  visualDirection: z.string().trim().max(5_000),
  forbidden: z.array(z.string().trim().min(1).max(300)).max(50),
  roles: z.array(z.strictObject({ key: z.string().trim().min(1).max(60), instruction: z.string().trim().min(1).max(1_000) })).min(1).max(8)
});
```

All three mutation routes must call `rejectNonLoopback` and `rejectUnsafeBrowserMutation` before parsing JSON.

- [ ] **Step 5: Run API/service tests**

Run: `pnpm --filter @tk/web test -- src/server/services/template-service.test.ts src/app/api/v1/templates/route.ts`

Expected: PASS.

- [ ] **Step 6: Commit template lifecycle**

```bash
git add apps/web/src/server/services/template-service.ts apps/web/src/server/services/template-service.test.ts apps/web/src/app/api/v1/templates packages/contracts/src/read-models.ts
git commit -m "feat: add versioned image recipe lifecycle"
```

### Task 4: Add Prompt Planner Adapter with Strict Structured Output

**Files:**
- Create: `packages/adapters/src/image-generation/openai-image-planner.ts`
- Create: `packages/adapters/src/image-generation/openai-image-planner.test.ts`
- Create: `packages/adapters/src/image-generation/provider-errors.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: `ImagePromptPlannerPort`, `ImageGenerationRecipeV1`, and `validatePlannedPrompts`.
- Produces: `createOpenAiImagePlanner({ baseUrl, apiKey, model, fetchImpl })`.

- [ ] **Step 1: Write failing tests for exact count, repair, and safe errors**

```ts
it("repairs malformed output before returning prompts", async () => {
  const fetchImpl = sequenceFetch([
    jsonResponse({ choices: [{ message: { content: "not-json" } }] }),
    jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(3)) } }] })
  ]);
  const planner = createOpenAiImagePlanner(config(fetchImpl));
  await expect(planner.plan(planInput(3))).resolves.toMatchObject({ prompts: [{ slot: 1 }, { slot: 2 }, { slot: 3 }] });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("maps 429 without leaking provider body", async () => {
  const planner = createOpenAiImagePlanner(config(async () => new Response("secret upstream body", { status: 429 })));
  await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "retryable", code: "image_planner_rate_limited" });
});
```

- [ ] **Step 2: Run tests and verify adapter is missing**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-image-planner.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement one normal request plus one bounded repair request**

Send selected images as local data URLs after validating MIME and byte limits. Require JSON output with `{ prompts: [...] }`, call `validatePlannedPrompts`, and on schema failure make one repair call containing only the safe validation code and invalid JSON—not credentials or binary images. Map 401/403 and missing model to fatal configuration failures; map 429/502/503 and timeouts to retryable failures.

- [ ] **Step 4: Run adapter tests and typecheck**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-image-planner.test.ts && pnpm --filter @tk/adapters typecheck`

Expected: PASS.

- [ ] **Step 5: Commit planner adapter**

```bash
git add packages/adapters/src/image-generation packages/adapters/src/index.ts
git commit -m "feat: add structured image prompt planner"
```

### Task 5: Add Single-Slot Image Provider Adapter

**Files:**
- Create: `packages/adapters/src/image-generation/openai-compatible-image-provider.ts`
- Create: `packages/adapters/src/image-generation/openai-compatible-image-provider.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: `ImageGenerationPort` and safe provider failure mapping from Task 4.
- Produces: `createOpenAiCompatibleImageProvider({ baseUrl, apiKey, model, fetchImpl })` with one paid submission per stable idempotency key and support for Agnes-style synchronous or asynchronous responses.

- [ ] **Step 1: Write failing submission, polling, and unknown-result tests**

```ts
it("sends one slot with a stable idempotency header", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_123", status: "queued" }));
  const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
  await expect(provider.submit(slotInput("slot-key-1"))).resolves.toEqual({ kind: "accepted", remoteTaskId: "task_123" });
  expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ "Idempotency-Key": "slot-key-1" });
});

it("accepts a synchronous Agnes image URL", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ url: "https://cdn.test/result.png" }] }));
  const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
  await expect(provider.submit(slotInput("slot-key-2"))).resolves.toEqual({ kind: "completed", outputUrl: "https://cdn.test/result.png" });
});

it("returns pending without resubmitting", async () => {
  const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_123", status: "processing" }));
  const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
  await expect(provider.fetch({ remoteTaskId: "task_123" })).resolves.toEqual({ state: "pending" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and verify provider is missing**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-compatible-image-provider.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement provider submit/fetch without Canvas assumptions**

The adapter must accept one prompt and 1–6 local reference paths, post OpenAI-compatible JSON to `/v1/images/generations`, and put reference images in `extra_body.image` as bounded data URLs for Agnes-compatible models. Use a 30-second connect timeout and a bounded 30-minute response timeout, never log response bodies, and parse either one final URL or a task ID. It must not reference `/api/automation/upload`, Canvas workflow IDs, Canvas asset URLs, or Canvas polling routes.

- [ ] **Step 4: Run adapter tests**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-compatible-image-provider.test.ts && pnpm --filter @tk/adapters typecheck`

Expected: PASS.

- [ ] **Step 5: Commit image provider adapter**

```bash
git add packages/adapters/src/image-generation/openai-compatible-image-provider.ts packages/adapters/src/image-generation/openai-compatible-image-provider.test.ts packages/adapters/src/index.ts
git commit -m "feat: add independent image generation provider"
```

### Task 6: Implement Planner Worker Job

**Files:**
- Create: `apps/worker/src/handlers/plan-images.ts`
- Create: `apps/worker/src/handlers/plan-images.test.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/composition.test.ts`

**Interfaces:**
- Consumes: `ImagePromptPlannerPort`, `ImageGenerationRepository.loadPlanningContext`, and `savePlanAndQueueSlots`.
- Produces: `createPlanImagesHandler` registered as `image_prompt_plan`.

- [ ] **Step 1: Write failing worker tests proving image quota is not spent on invalid plans**

```ts
it("persists exactly M prompts and releases exactly M slot jobs", async () => {
  const planner = { plan: vi.fn(async () => ({ prompts: validPlan(5).prompts })) };
  const result = await createPlanImagesHandler(deps({ planner }))(job("batch_1"), execution());
  expect(repository.savePlanAndQueueSlots).toHaveBeenCalledWith("batch_1", expect.objectContaining({ prompts: expect.arrayContaining([{ slot: 5 }]) }), expect.anything());
  expect(result.next).toHaveLength(0); // repository transaction owns slot enqueueing
});

it("does not enqueue slots when prompt count mismatches", async () => {
  const planner = { plan: vi.fn(async () => ({ prompts: validPlan(4).prompts })) };
  await expect(createPlanImagesHandler(deps({ planner }))(job("batch_5"), execution())).rejects.toMatchObject({ code: "image_plan_slots_invalid" });
  expect(repository.savePlanAndQueueSlots).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the handler test and verify it fails**

Run: `pnpm --filter @tk/worker test -- src/handlers/plan-images.test.ts`

Expected: FAIL with missing handler.

- [ ] **Step 3: Implement planner handler and retry classification**

The handler loads the frozen context by `batchId`, calls the planner using `plan:${batchId}` as idempotency key, validates exact count again at the worker boundary, and uses one fenced repository transaction to persist prompts and queue slots. Retryable planner failures use existing `RetryableJobError`; configuration failures become `NeedsInputError` with Chinese-safe UI mapping through the read projection.

- [ ] **Step 4: Register the handler and update composition assertions**

Add `image_prompt_plan` to the handler map and assert the complete registered job-kind set in `composition.test.ts`.

- [ ] **Step 5: Run worker unit tests**

Run: `pnpm --filter @tk/worker test -- src/handlers/plan-images.test.ts src/composition.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit planner worker**

```bash
git add apps/worker/src/handlers/plan-images.ts apps/worker/src/handlers/plan-images.test.ts apps/worker/src/main.ts apps/worker/src/composition.test.ts
git commit -m "feat: plan persistent image generation slots"
```

### Task 7: Implement Independently Recoverable Slot Worker

**Files:**
- Create: `apps/worker/src/handlers/generate-image-slot.ts`
- Create: `apps/worker/src/handlers/generate-image-slot.test.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/runtime/adapter-limiter.ts`
- Modify: `apps/worker/src/runtime/adapter-limiter.test.ts`
- Modify: `apps/worker/src/runtime/recovery.test.ts`
- Modify: `apps/worker/src/runtime/recovery.pg.test.ts`

**Interfaces:**
- Consumes: `ImageGenerationPort`, `ContentAddressedStore.archive`, and slot repository operations.
- Produces: `createGenerateImageSlotHandler` registered as `image_generate_slot`.

- [ ] **Step 1: Write failing tests for reconciliation and local-archive success**

```ts
it("polls an existing task instead of submitting again", async () => {
  const provider = { submit: vi.fn(), fetch: vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" })) };
  await createGenerateImageSlotHandler(deps({ provider, remoteTaskId: "remote_1" }))(slotJob(), execution());
  expect(provider.submit).not.toHaveBeenCalled();
  expect(store.archive).toHaveBeenCalledWith("https://provider.test/out.png");
});

it("does not mark success when archive validation fails", async () => {
  const store = { archive: vi.fn(async () => { throw new Error("unsupported image"); }) };
  await expect(createGenerateImageSlotHandler(deps({ store, remoteTaskId: "remote_1" }))(slotJob(), execution())).rejects.toBeDefined();
  expect(repository.markSlotSucceeded).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify the handler is missing**

Run: `pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts`

Expected: FAIL with missing handler.

- [ ] **Step 3: Implement submit intent, immediate task persistence, poll, and archive**

Before submit, call `execution.persistReconciliationIntent` with operation `image_generate_slot`. If submit returns `accepted`, immediately call `execution.persistRemoteTask`; if it returns `completed`, proceed directly to archival. If a remote task already exists, call `fetch` only. Map `pending` to a 30-second `RetryableJobError`. After a final URL, archive via `ContentAddressedStore`, require nonzero dimensions and supported PNG/JPEG bytes, then persist local asset ID using the lease fence.

- [ ] **Step 4: Add duplicate and sibling quality metadata without auto-rejecting fidelity**

Store SHA-256 and perceptual similarity warnings on the slot/batch projection. Exact duplicate output may be marked failed with `image_output_duplicate`; high similarity is a review warning only. Do not automatically decide product color correctness or commercial suitability.

- [ ] **Step 5: Enforce the frozen provider concurrency limit**

Extend the existing adapter limiter so `image_generate_slot` acquisitions are keyed by the frozen provider/model pair and capped by `recipe_snapshot.imageProvider.concurrency`. Add a test with concurrency `2` that blocks the third provider call until one of the first two releases; retries and polling must use the same limiter.

- [ ] **Step 6: Extend restart recovery tests**

Cover restart after intent, after remote-task persistence, during polling, and during archive download. Each case must assert provider `submit` count remains one for a successful paid slot.

- [ ] **Step 7: Run worker unit and PostgreSQL recovery tests**

Run: `pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts src/runtime/adapter-limiter.test.ts src/runtime/recovery.test.ts && pnpm --filter @tk/worker test:integration -- src/runtime/recovery.pg.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit slot worker**

```bash
git add apps/worker/src/handlers/generate-image-slot.ts apps/worker/src/handlers/generate-image-slot.test.ts apps/worker/src/main.ts apps/worker/src/runtime/adapter-limiter.ts apps/worker/src/runtime/adapter-limiter.test.ts apps/worker/src/runtime/recovery.test.ts apps/worker/src/runtime/recovery.pg.test.ts
git commit -m "feat: generate and recover image slots independently"
```

### Task 8: Compose Configured Planner and Image Provider Ports

**Files:**
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `packages/adapters/src/factory.ts`
- Modify: `packages/adapters/src/factory.test.ts`
- Modify: `packages/adapters/src/testing/fakes.ts`
- Modify: `packages/contracts/src/testing/fake-ports.ts`
- Modify: `apps/worker/src/entry.ts`
- Modify: `apps/worker/src/entry.test.ts`

**Interfaces:**
- Consumes: adapters and handlers from Tasks 4–7.
- Produces: `AdapterBundle.imagePlanner`, `AdapterBundle.imageGeneration`, safe config fields, deterministic fakes, and production worker composition.

- [ ] **Step 1: Write failing config/factory tests**

```ts
it("reports image generation configured only when both planner and image provider are complete", () => {
  const config = loadConfig(baseEnv({ IMAGE_PROVIDER_BASE_URL: "https://images.test", IMAGE_PROVIDER_API_KEY: "key", IMAGE_PROVIDER_MODEL: "model" }));
  expect(config.imageGenerationConfigured).toBe(true);
});

it("refuses live worker startup with an incomplete image provider", () => {
  expect(() => createAdapterBundle(liveConfig({ imageProviderApiKey: "" }), stableContext())).toThrow("live adapter configuration is incomplete");
});
```

- [ ] **Step 2: Run config/factory tests and verify fields are missing**

Run: `pnpm --filter @tk/config test -- src/env.test.ts && pnpm --filter @tk/adapters test -- src/factory.test.ts`

Expected: FAIL for missing image-provider configuration.

- [ ] **Step 3: Add config fields without logging secrets**

Add `IMAGE_PLANNER_BASE_URL`, `IMAGE_PLANNER_API_KEY`, `IMAGE_PLANNER_MODEL`, `IMAGE_PROVIDER_BASE_URL`, `IMAGE_PROVIDER_API_KEY`, and `IMAGE_PROVIDER_MODEL`. `getSecretStatus` returns only `imageGenerationConfigured: boolean`; no API response exposes URLs, keys, or raw models in daily UI.

- [ ] **Step 4: Compose live and deterministic fake ports**

Extend `AdapterBundle` and fake counters with `imagePlanner` and `imageGeneration`. Live construction uses the new adapters. Worker entry injects the repository, ports, audit, and local content store into both handlers.

- [ ] **Step 5: Run composition tests and typecheck**

Run: `pnpm --filter @tk/config test && pnpm --filter @tk/adapters test && pnpm --filter @tk/worker test -- src/entry.test.ts src/composition.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit composition**

```bash
git add packages/config/src packages/adapters/src packages/contracts/src/testing apps/worker/src/entry.ts apps/worker/src/entry.test.ts
git commit -m "feat: compose headless image generation providers"
```

### Task 9: Add Web Commands for Start, Retry, Exclude, and Partial Acceptance

**Files:**
- Create: `apps/web/src/server/services/image-generation-service.ts`
- Create: `apps/web/src/server/services/image-generation-service.test.ts`
- Modify: `apps/web/src/server/composition.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/image-generations/route.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/image-generations/route.test.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/image-generations/[batchId]/slots/[slotId]/route.ts`
- Create: `apps/web/src/app/api/v1/products/[productId]/image-generations/[batchId]/accept/route.ts`

**Interfaces:**
- Consumes: repository operations from Task 2 and active-template resolution from Task 3.
- Produces: `ImageGenerationService.start`, `retrySlot`, `excludeSlot`, and `acceptPartial`.

- [ ] **Step 1: Write failing command tests**

```ts
it("starts with frozen ordered assets and an active resolved template", async () => {
  await service.start({ productId: "prod_1", revisionId: "rev_1", categoryKey: "women.hat", selectedAssetIds: ["asset_2", "asset_1"], outputCount: 5 });
  expect(repository.createBatch).toHaveBeenCalledWith(expect.objectContaining({ selectedAssetIds: ["asset_2", "asset_1"], requestedOutputCount: 5, templateVersion: 2 }));
});

it("retries only a failed slot", async () => {
  await service.retrySlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_4" });
  expect(repository.retrySlot).toHaveBeenCalledWith(expect.objectContaining({ slotId: "slot_4" }));
});
```

- [ ] **Step 2: Run service/API tests and verify modules are missing**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts src/app/api/v1/products/[productId]/image-generations/route.test.ts`

Expected: FAIL with missing service/routes.

- [ ] **Step 3: Implement service invariants**

Reject assets outside the current product revision, non-ready assets, duplicate asset IDs, 0/7 inputs, 0/9 outputs, inactive/missing templates, retry of a successful/excluded slot, and acceptance with zero successful non-excluded slots. Derive idempotency from revision ID plus SHA-256 of ordered asset IDs, category, template version, and output count.

- [ ] **Step 4: Add protected API routes**

`POST /image-generations` starts a batch. Slot `PATCH` accepts exactly `{ action: "retry" | "exclude" }`. Accept route accepts exactly `{ orderedSlotIds: string[] }`. Every mutation uses loopback and unsafe-browser guards and returns 409 for stale revision/template/slot state.

- [ ] **Step 5: Run Web service/API tests**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts src/app/api/v1/products/[productId]/image-generations/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Web commands**

```bash
git add apps/web/src/server/services/image-generation-service.ts apps/web/src/server/services/image-generation-service.test.ts apps/web/src/server/composition.ts apps/web/src/app/api/v1/products/[productId]/image-generations
git commit -m "feat: add image generation commands"
```

### Task 10: Project Persistent Generation State into Product Detail

**Files:**
- Modify: `packages/contracts/src/read-models.ts`
- Modify: `apps/web/src/server/services/product-service.ts`
- Modify: `apps/web/src/server/services/product-service.test.ts`
- Modify: `apps/web/src/app/api/v1/products/[productId]/route.ts`

**Interfaces:**
- Consumes: generation batch/slot tables and local asset content URLs.
- Produces: `ProductWorkspaceV1.imageGeneration` with all selectable local inputs, batch-frozen selected inputs, inferred/confirmed category, slots, counts, warnings, and human-readable status.

- [ ] **Step 1: Write failing projection tests**

```ts
it("keeps original and processed images separate and local", async () => {
  const workspace = await service.get("prod_1");
  expect(workspace?.imageGeneration?.availableInputs).toHaveLength(6);
  expect(workspace?.imageGeneration?.selectedInputs[0]?.url).toMatch(/^\/api\/v1\/assets\//);
  expect(workspace?.imageGeneration?.slots.find((slot) => slot.status === "succeeded")?.localUrl).toMatch(/^\/api\/v1\/assets\//);
  expect(workspace?.originalListing?.mainImages).not.toContain(workspace?.imageGeneration?.slots[0]?.localUrl);
});

it("derives partial progress from persisted slots", async () => {
  const workspace = await service.get("prod_partial");
  expect(workspace?.imageGeneration).toMatchObject({ requestedCount: 5, successfulCount: 4, state: "partial" });
});
```

- [ ] **Step 2: Run projection tests and verify field is absent**

Run: `pnpm --filter @tk/web test -- src/server/services/product-service.test.ts`

Expected: FAIL because `imageGeneration` is not projected.

- [ ] **Step 3: Add one SQL projection for latest batch and ordered slots**

Use one lateral query for all ready assets archived from the current revision as `availableInputs`, another for the latest generation batch, and aggregate slots ordered by `slot_number`. Before the first batch, return `inferredCategory` from `inferImageCategory`; after start, return the frozen confirmed category. Generate local URLs only for `assets.state = 'ready'`; never expose filesystem paths or remote provider URLs. Map states to safe Chinese copy such as `正在分析商品图片`, `正在准备 5 张图片`, `已生成 4/5`, and `已完成 4/5，可使用当前结果`.

- [ ] **Step 4: Run product API/projection tests**

Run: `pnpm --filter @tk/web test -- src/server/services/product-service.test.ts src/app/api/v1/api.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit product projection**

```bash
git add packages/contracts/src/read-models.ts apps/web/src/server/services/product-service.ts apps/web/src/server/services/product-service.test.ts apps/web/src/app/api/v1/products/[productId]/route.ts
git commit -m "feat: expose persistent image generation progress"
```

### Task 11: Build the Compact Product-Detail Generation Panel

**Files:**
- Create: `apps/web/src/components/products/image-generation-panel.tsx`
- Create: `apps/web/src/components/products/image-generation-panel.test.tsx`
- Modify: `apps/web/src/components/review/final-review.tsx`
- Modify: `apps/web/src/app/products/[productId]/page.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `ProductWorkspaceV1.imageGeneration` and Task 9 API routes.
- Produces: category override, 1–6 thumbnail selection, 1–8 output count, start action, persisted progress, per-slot retry/exclude, and partial acceptance.

- [ ] **Step 1: Write failing user-flow component tests**

```tsx
it("starts the default flow with one action", async () => {
  render(<ImageGenerationPanel productId="prod_1" revisionId="rev_1" model={readyModel()} />);
  await userEvent.click(screen.getByRole("button", { name: "开始洗图" }));
  expect(fetch).toHaveBeenCalledWith("/api/v1/products/prod_1/image-generations", expect.objectContaining({ method: "POST" }));
});

it("retries only image four after partial completion", async () => {
  render(<ImageGenerationPanel productId="prod_1" revisionId="rev_1" model={partialModel()} />);
  await userEvent.click(screen.getByRole("button", { name: "重试第 4 张" }));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/slots/slot_4"), expect.objectContaining({ method: "PATCH" }));
});
```

- [ ] **Step 2: Run component/page tests and verify panel is missing**

Run: `pnpm --filter @tk/web test -- src/components/products/image-generation-panel.test.tsx src/app/products/[productId]/page.test.tsx`

Expected: FAIL with missing panel.

- [ ] **Step 3: Implement the compact daily panel**

Render inferred category with `更改`, selected original thumbnails, `- / +` output count, and one `开始洗图` button. During execution render server-backed `已生成 N/M`, slot cards, and only `放大`, `重新生成这张`, and `排除这张`. Use `router.refresh()` after mutations and a 3-second refresh while any slot is nonterminal; stop polling when the component unmounts or the batch is terminal.

- [ ] **Step 4: Add focused responsive styles**

Use existing card, button, status, thumbnail, and dialog tokens. Keep provider configuration, raw prompts, job IDs, and error payloads out of the panel. Do not redesign unrelated product list or navigation surfaces.

- [ ] **Step 5: Run component, page, accessibility, and type tests**

Run: `pnpm --filter @tk/web test -- src/components/products/image-generation-panel.test.tsx src/app/products/[productId]/page.test.tsx src/components/products/product-drawer.accessibility.test.tsx && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit product UI**

```bash
git add apps/web/src/components/products/image-generation-panel.tsx apps/web/src/components/products/image-generation-panel.test.tsx apps/web/src/components/review/final-review.tsx apps/web/src/app/products/[productId]/page.test.tsx apps/web/src/app/globals.css
git commit -m "feat: add simple product image generation panel"
```

### Task 12: Expand Template Management and Prompt-Only Tests

**Files:**
- Modify: `apps/web/src/components/templates/template-manager.tsx`
- Create: `apps/web/src/components/templates/template-manager.test.tsx`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/prompt-test/route.ts`
- Create: `apps/web/src/app/api/v1/templates/[templateId]/prompt-test/route.test.ts`
- Modify: `apps/web/src/app/templates/page.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: template lifecycle from Task 3 and `ImagePromptPlannerPort` through a prompt-test service that never creates generation jobs.
- Produces: all-user template create/edit/duplicate/test/activate/archive/restore UI.

- [ ] **Step 1: Write failing UI and API tests**

```tsx
it("shows lifecycle actions without role restrictions", () => {
  render(<TemplateManager items={[activeTemplate(), draftTemplate()]} />);
  expect(screen.getByRole("button", { name: "测试提示词" })).toBeVisible();
  expect(screen.getByRole("button", { name: "启用此版本" })).toBeVisible();
  expect(screen.getByRole("button", { name: "恢复为新草稿" })).toBeVisible();
});

it("prompt-only test creates no image jobs", async () => {
  const response = await handler(promptTestRequest({ productId: "prod_1", outputCount: 5 }));
  expect(response.status).toBe(200);
  expect(jobRepository.enqueue).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run template UI/API tests and verify features are missing**

Run: `pnpm --filter @tk/web test -- src/components/templates/template-manager.test.tsx src/app/api/v1/templates/[templateId]/prompt-test/route.test.ts`

Expected: FAIL for missing lifecycle controls and prompt-test route.

- [ ] **Step 3: Implement the practical editor**

Expose name/category, default input/output counts, must-preserve rules, visual direction, forbidden content, and ordered roles. Put planner/provider/model/ratio/resolution/quality/concurrency fields inside a collapsed `高级设置`. The list shows category, active version, defaults, test, edit, activate, archive, and restore actions.

- [ ] **Step 4: Implement prompt-only test without batch or slot writes**

Load an existing product, selected local source assets, and the chosen draft/active version; call the planner and return validated prompts. Record a redacted audit event, but do not insert `image_generation_batches`, `image_generation_slots`, or image provider jobs.

- [ ] **Step 5: Run template tests and typecheck**

Run: `pnpm --filter @tk/web test -- src/components/templates/template-manager.test.tsx src/app/api/v1/templates/[templateId]/prompt-test/route.test.ts && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit template UI**

```bash
git add apps/web/src/components/templates/template-manager.tsx apps/web/src/components/templates/template-manager.test.tsx apps/web/src/app/templates/page.tsx apps/web/src/app/api/v1/templates/[templateId]/prompt-test apps/web/src/app/globals.css
git commit -m "feat: manage and test category image templates"
```

### Task 13: Integrate Accepted Slot Assets into Review and Miaoshou Writeback

**Files:**
- Modify: `apps/web/src/components/review/final-review.tsx`
- Modify: `apps/web/src/components/review/final-image-order.tsx`
- Modify: `apps/web/src/components/review/final-image-order.test.tsx`
- Modify: `packages/db/src/repositories/approval-repository.ts`
- Modify: `apps/worker/src/handlers/prepare-miaoshou-writeback.ts`
- Modify: `apps/worker/src/handlers/prepare-miaoshou-writeback.test.ts`
- Modify: `packages/contracts/src/ports.ts`
- Create: `packages/adapters/src/publishing/asset-publishing-adapter.ts`
- Create: `packages/adapters/src/publishing/asset-publishing-adapter.test.ts`
- Modify: `packages/adapters/src/factory.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `apps/worker/src/entry.ts`

**Interfaces:**
- Consumes: accepted successful local asset IDs from Task 9 and existing approval snapshots.
- Produces: ordered review assets and `AssetPublishingPort.publish({ localAssetIds, purpose: "miaoshou_edit" })` independent of Canvas, backed by a configured stable object-storage upload endpoint.

- [ ] **Step 1: Write failing review/writeback tests**

```ts
it("orders accepted successful generated assets without source-image mixing", () => {
  expect(buildFinalImageCandidates(workspaceWithAcceptedSlots())).toEqual([
    expect.objectContaining({ assetId: "generated_hero", kind: "processed" }),
    expect.objectContaining({ assetId: "generated_detail", kind: "processed" })
  ]);
});

it("publishes local approval assets without Canvas staging", async () => {
  await handler(writebackJob(), execution());
  expect(publishing.publish).toHaveBeenCalledWith({ localAssetIds: ["generated_hero"], purpose: "miaoshou_edit" });
  expect(canvas.submit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run review/writeback tests and verify transport boundary is absent**

Run: `pnpm --filter @tk/web test -- src/components/review/final-image-order.test.tsx && pnpm --filter @tk/worker test -- src/handlers/prepare-miaoshou-writeback.test.ts`

Expected: FAIL because accepted slots and non-Canvas publishing are not wired.

- [ ] **Step 3: Feed accepted asset IDs into approval snapshots**

Only slot rows with `state = 'succeeded'`, non-null `archived_asset_id`, and not excluded may enter the accepted order. Preserve user order and verify each asset is `ready` during approval transaction creation.

- [ ] **Step 4: Replace Canvas-purpose staging with a concrete publishing port**

Add `ASSET_PUBLISH_UPLOAD_URL`, `ASSET_PUBLISH_PUBLIC_BASE_URL`, and `ASSET_PUBLISH_TOKEN`. For each local content hash, `asset-publishing-adapter.ts` performs an idempotent `PUT` to `${ASSET_PUBLISH_UPLOAD_URL}/${sha256}.${extension}` with the bearer token and returns `${ASSET_PUBLISH_PUBLIC_BASE_URL}/${sha256}.${extension}`. Treat an existing-object 409 as success after a `HEAD` check. Validate that the returned URL is HTTPS and under the configured public origin. No code in writeback may read `CANVAS_BASE_URL`, `/api/automation/upload`, or `/assets/output/`.

- [ ] **Step 5: Run review, worker, and adapter tests**

Run: `pnpm --filter @tk/web test -- src/components/review/final-image-order.test.tsx && pnpm --filter @tk/worker test -- src/handlers/prepare-miaoshou-writeback.test.ts src/handlers/miaoshou-edit.test.ts && pnpm --filter @tk/adapters test -- src/publishing/asset-publishing-adapter.test.ts && pnpm --filter @tk/config test -- src/env.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit approval/writeback integration**

```bash
git add apps/web/src/components/review packages/db/src/repositories/approval-repository.ts apps/worker/src/handlers/prepare-miaoshou-writeback.ts apps/worker/src/handlers/prepare-miaoshou-writeback.test.ts apps/worker/src/entry.ts packages/contracts/src/ports.ts packages/adapters/src/publishing packages/adapters/src/factory.ts packages/adapters/src/index.ts packages/config/src/env.ts packages/config/src/env.test.ts
git commit -m "feat: publish approved local images without Canvas"
```

### Task 14: Switch New Production Work Off Canvas and Seed Initial Templates

**Files:**
- Modify: `apps/worker/src/handlers/select-images.ts`
- Modify: `apps/worker/src/handlers/pipeline-handlers.test.ts`
- Modify: `packages/db/src/repositories/pipeline-repository.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/contracts/src/read-models.ts`
- Modify: `apps/web/src/server/services/settings-service.ts`
- Modify: `apps/web/src/components/settings/sections/secret-status-section.tsx`
- Create: `apps/web/src/components/settings/__tests__/secret-status-section.test.tsx`
- Modify: `scripts/postgres-init.sql`
- Create: `scripts/seed-image-generation-templates.mjs`
- Create: `scripts/tests/seed-image-generation-templates.test.mjs`

**Interfaces:**
- Consumes: complete headless pipeline and non-Canvas writeback from Tasks 1–13.
- Produces: `PipelineRepository.markReadyForImageGeneration`, generic/hat/jewelry/apparel recipes, and production readiness based on image providers rather than Canvas.

- [ ] **Step 1: Write failing switch and seed tests**

```ts
it("finishes image selection without creating a Canvas job", async () => {
  const result = await createSelectImagesHandler(repository)(job("image_select", { revisionId: "rev_new" }), execution());
  expect(result.next).toEqual([]);
  expect(repository.markReadyForGeneration).toHaveBeenCalledWith("rev_new", expect.anything());
});
```

Seed-script assertions must verify exactly one active version for `generic`, `apparel`, `jewelry`, and `women.hat`, all counts within 1–6/1–8, and idempotent re-runs.

- [ ] **Step 2: Run switch/seed tests and verify old routing remains**

Run: `pnpm --filter @tk/worker test -- src/handlers/pipeline-handlers.test.ts && node --test scripts/tests/seed-image-generation-templates.test.mjs`

Expected: FAIL because new automation still routes through Canvas and seed script is missing.

- [ ] **Step 3: Seed clean initial recipes**

Create generic, apparel, jewelry, and women's-hat templates using the approved preservation hierarchy. Do not import Canvas coordinates, cached model output, placeholder images, node IDs, or jewelry-specific prior runtime output. Default to 3 inputs and 5 outputs, with eight ordered roles so every supported output count is valid: `hero`, `benefit`, `scene`, `detail`, `audience`, `alternate_scene`, `sku_presentation`, and `packaging`.

- [ ] **Step 4: Switch only new work and keep legacy reads**

After image selection, call `PipelineRepository.markReadyForImageGeneration` to persist `{ imageGenerationReady: true }` in the revision working draft and return no next job. The product-detail command from Task 9 creates the headless batch and planner job using the user's selected inputs and output count. Existing `canvas_runs`, completed output assets, and already-enqueued `canvas_generate` jobs remain readable and may finish. Settings show `图片生成已配置`; Canvas status moves to diagnostics/deprecated compatibility and no longer blocks start or writeback.

- [ ] **Step 5: Run service, seed, and migration tests**

Run: `pnpm --filter @tk/worker test -- src/handlers/pipeline-handlers.test.ts && pnpm --filter @tk/web test -- src/components/settings/__tests__/secret-status-section.test.tsx && node --test scripts/tests/seed-image-generation-templates.test.mjs && pnpm db:migrate`

Expected: PASS.

- [ ] **Step 6: Commit cutover and seeds**

```bash
git add apps/worker/src/handlers/select-images.ts apps/worker/src/handlers/pipeline-handlers.test.ts packages/db/src/repositories/pipeline-repository.ts apps/web/src/server/services/settings-service.ts apps/web/src/components/settings packages/config/src/env.ts packages/contracts/src/read-models.ts scripts/postgres-init.sql scripts/seed-image-generation-templates.mjs scripts/tests/seed-image-generation-templates.test.mjs
git commit -m "feat: switch new image work off Canvas"
```

### Task 15: Verify the Full Story, Restart Safety, and Canvas-Off Operation

**Files:**
- Create: `e2e/headless-image-generation.spec.ts`
- Modify: `e2e/fixtures/test-database.ts`
- Modify: `e2e/fixtures/miaoshou-server.ts`
- Modify: `e2e/worker-recovery.spec.ts`
- Modify: `docs/operations/local-production.md`
- Create: `docs/operations/headless-image-generation.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: executable browser/restart acceptance and operator documentation.

- [ ] **Step 1: Write failing browser scenarios for the approved count matrix**

```ts
for (const scenario of [
  { inputs: 1, outputs: 1 },
  { inputs: 3, outputs: 5 },
  { inputs: 4, outputs: 5 },
  { inputs: 6, outputs: 8 }
]) {
  test(`${scenario.inputs} inputs to ${scenario.outputs} outputs`, async ({ page }) => {
    await seedProductWithLocalImages(scenario.inputs);
    await page.goto("/products/prod_headless");
    await selectInputs(page, scenario.inputs);
    await setOutputCount(page, scenario.outputs);
    await page.getByRole("button", { name: "开始洗图" }).click();
    await expect(page.getByText(`已生成 ${scenario.outputs}/${scenario.outputs}`)).toBeVisible();
    await expect(page.getByTestId("processed-image")).toHaveCount(scenario.outputs);
  });
}
```

- [ ] **Step 2: Add partial-result and per-slot action scenarios**

Configure the fake provider so slot 4 fails twice while siblings succeed. Assert the page shows `已完成 4/5，可使用当前结果`, retrying slot 4 does not change successful slot asset IDs, excluding slot 4 allows partial acceptance, and originals remain in a separate gallery.

- [ ] **Step 3: Add restart checkpoints**

Restart the worker during planning, after slot submit intent, during polling, and during output download. Assert the database retains the batch, all slots, remote task IDs, and local asset IDs, and fake provider submission count is one per successful business key.

- [ ] **Step 4: Add Canvas-off writeback acceptance**

Start Web/worker without Infinite-Canvas and without `CANVAS_BASE_URL`. Generate, accept, approve, and write back a product through the Miaoshou fixture. Assert the edit request contains published URLs derived from accepted local asset IDs and the browser reaches writeback success.

- [ ] **Step 5: Run complete automated verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e -- e2e/headless-image-generation.spec.ts e2e/worker-recovery.spec.ts
git diff --check
```

Expected: all commands exit 0; no external live provider calls occur in tests.

- [ ] **Step 6: Run parallel and Canvas-off live acceptance with explicit real-provider credentials**

Before enabling the headless path for new production work, run the same women's-hat, jewelry, and apparel samples through legacy Canvas and the headless path and record input evidence, prompt quality, fidelity, output count, latency, provider-call count, restart recovery, and local archive completeness side by side. Then use the repo startup script, verify `http://127.0.0.1:3000/products/`, and run the four required count scenarios on the headless path. During separate runs, restart the worker at planning, generation, polling, and download. Record local asset IDs and proof that accepted images and Miaoshou writeback remain functional with Canvas stopped.

- [ ] **Step 7: Document operations and recovery**

Document required image planner/provider variables, safe status checks, how to retry a single slot, how to accept partial output, how to identify configuration failures, and how to confirm a successful image is locally archived. Mark Canvas variables as legacy-only for existing tasks.

- [ ] **Step 8: Commit acceptance coverage and operations docs**

```bash
git add e2e/headless-image-generation.spec.ts e2e/fixtures e2e/worker-recovery.spec.ts docs/operations/local-production.md docs/operations/headless-image-generation.md
git commit -m "test: verify headless image generation end to end"
```

---

## Final Release Gate

- [ ] Confirm every requested output count creates exactly that many persistent slots.
- [ ] Confirm restart loses no batch, slot, remote task, or successful local asset.
- [ ] Confirm a failed sibling never regenerates a successful paid slot.
- [ ] Confirm original and processed galleries remain visibly separate.
- [ ] Confirm all template lifecycle actions are available to every local user.
- [ ] Confirm prompt-only testing creates no image-provider jobs.
- [ ] Confirm active-template changes do not alter existing batches.
- [ ] Confirm accepted partial output preserves explicit order.
- [ ] Confirm the complete new path works with Infinite-Canvas stopped.
- [ ] Confirm Miaoshou writeback uses no Canvas upload or hosted URL.
- [ ] Confirm legacy Canvas history and assets remain readable.
- [ ] Inspect `git status --short` and exclude unrelated pre-existing changes from every commit.
