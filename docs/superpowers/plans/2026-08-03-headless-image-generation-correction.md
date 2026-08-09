# Headless Image Generation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the current headless image-generation branch so selected product images and category templates produce durable local assets that can be reviewed and written back to Miaoshou without Infinite-Canvas, while preserving explicit Canvas rollback compatibility.

**Architecture:** Keep the existing Web command, PostgreSQL batch/slot jobs, TypeScript Worker, and provider ports. Correct the boundaries in dependency order: frozen input and asset resolution, provider calls, durable archival, recovery, publishing, production composition, then full-system verification. Asset IDs, local paths, provider URLs, and public URLs remain distinct types and are converted only by the owning boundary.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, PostgreSQL/pg, Next.js, AWS SDK v3 S3 client, Playwright.

## Global Constraints

- Work only in `/mnt/d/project/TKcaiji/tk-commerce-workbench/.worktrees/headless-image-gen` on `feat/headless-image-gen`.
- Preserve `IMAGE_GENERATION_PATH=canvas` and existing Canvas handlers, history, assets, and jobs.
- Do not call a live image provider until lint, typecheck, build, unit, integration, and Mock E2E gates pass.
- Use red-green-refactor for every behavior change and commit each task independently.
- Do not stage or commit existing untracked `docs/superpowers/agents/**` files.
- An asset ID is never a filesystem path or URL; a local path is never stored in an asset-ID column.
- Every successful image-generation slot references a ready local `assets` row.
- Retry job payload `version` is always `1`; slot attempt is separate and slot numbers are 1-8.

---

## File Structure

- `packages/contracts/src/image-generation.ts`: frozen recipe, resolved reference, provider parameter, and job payload contracts.
- `packages/db/src/repositories/image-generation-repository.ts`: batch creation, selected-asset resolution, slot transitions, retry, durable generated-asset persistence, and product projection.
- `packages/db/src/assets/content-addressed-store.ts`: bounded byte download, magic validation, dimensions, hashing, and atomic local storage.
- `apps/web/src/server/services/image-generation-service.ts`: product/revision/template validation and immutable batch command.
- `apps/worker/src/handlers/plan-images.ts`: load frozen planning context and call the planner with resolved local images.
- `apps/worker/src/handlers/generate-image-slot.ts`: submit/poll/recover one paid slot and persist its ready asset.
- `packages/adapters/src/image-generation/openai-image-planner.ts`: multimodal prompt-planning request and strict response validation.
- `packages/adapters/src/image-generation/openai-compatible-image-provider.ts`: Agnes-compatible generation submit/fetch and separate timeout bounds.
- `packages/adapters/src/publishing/asset-publishing-adapter.ts`: byte-addressed HTTPS publishing.
- `apps/worker/src/entry.ts` and `apps/worker/src/main.ts`: production dependency composition and limiting.
- `e2e/headless-image-generation.spec.ts` and `e2e/worker-recovery.spec.ts`: Canvas-off user flow and restart checkpoints.

---

### Task 1: Freeze shared headless contracts

**Files:**
- Modify: `packages/contracts/src/image-generation.ts`
- Modify: `packages/contracts/src/image-generation.test.ts`
- Modify: `packages/contracts/src/testing/fakes.ts`

**Interfaces:**
- Produces: `FrozenImageGenerationRecipeV1`, `ResolvedImageReferenceV1`, `ImageGenerateSlotJobPayloadV1`.
- Produces: `ImagePromptPlannerPort.plan()` and `ImageGenerationPort.submit()` accepting resolved references and frozen provider parameters.

- [ ] **Step 1: Write failing contract tests**

Add tests that assert a frozen recipe preserves `mustPreserve`, `visualDirection`, `forbidden`, ordered role instructions, and provider parameters; assert slot payloads reject slot `0` and versions other than `1`.

```ts
expect(parseImageGenerateSlotJobPayload({
  version: 1, batchId: "batch_1", slotId: "slot_1", slotNumber: 1, attempt: 0
})).toEqual(expect.objectContaining({ slotNumber: 1, attempt: 0 }));
expect(() => parseImageGenerateSlotJobPayload({
  version: 1, batchId: "batch_1", slotId: "slot_1", slotNumber: 0, attempt: 1
})).toThrow(/slotNumber/);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm --filter @tk/contracts test -- src/image-generation.test.ts`

Expected: FAIL because the frozen recipe and payload parser do not exist.

- [ ] **Step 3: Implement the minimal versioned contracts**

```ts
export type ResolvedImageReferenceV1 = Readonly<{
  assetId: string;
  localPath: string;
  extension: "png" | "jpg" | "jpeg";
}>;

export type ImageGenerateSlotJobPayloadV1 = Readonly<{
  version: 1;
  batchId: string;
  slotId: string;
  slotNumber: number;
  attempt: number;
}>;
```

Use explicit runtime validation at the job boundary. Extend fake ports to use the same signatures.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `pnpm --filter @tk/contracts test -- src/image-generation.test.ts && pnpm --filter @tk/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/image-generation.ts packages/contracts/src/image-generation.test.ts packages/contracts/src/testing/fakes.ts
git commit -m "fix: freeze headless image generation contracts"
```

---

### Task 2: Validate and freeze product, template, and source-asset input

**Files:**
- Modify: `apps/web/src/server/services/image-generation-service.ts`
- Modify: `apps/web/src/server/services/image-generation-service.test.ts`
- Modify: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`

**Interfaces:**
- Consumes: `FrozenImageGenerationRecipeV1` from Task 1.
- Produces: `ImageGenerationRepository.loadStartContext({ productId, revisionId, selectedAssetIds })`.
- Produces: batches whose recipe and product-fact snapshots are complete and immutable.

- [ ] **Step 1: Write failing service and repository tests**

Cover these behaviors independently:

```ts
await expect(service.start({
  productId: "prod_1",
  revisionId: "rev_1",
  categoryKey: "women.hat",
  selectedAssetIds: ["asset_from_other_revision"],
  outputCount: 1
})).rejects.toMatchObject({ code: "asset_not_in_revision" });
```

Also assert that the `CreateBatchInput` contains real product facts and the complete active template recipe, not only role keys.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts`

Run: `pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: FAIL because ownership is not checked and facts/template fields are dropped.

- [ ] **Step 3: Implement one authoritative start-context query**

The query must join `products`, `product_revisions`, and `assets`, require every selected asset to match both product and revision and be `ready`, and return ordered references plus immutable facts derived from the revision source payload.

Map failures to stable service codes:

```text
product_not_found
revision_not_found
asset_not_ready
asset_not_in_revision
template_not_found
no_active_template_version
```

Freeze the entire validated recipe and product facts in `image_generation_batches`.

- [ ] **Step 4: Run focused Web and DB tests**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts && pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/image-generation-service.ts apps/web/src/server/services/image-generation-service.test.ts packages/db/src/repositories/image-generation-repository.ts packages/db/src/integration/repositories.integration.test.ts
git commit -m "fix: freeze owned headless generation inputs"
```

---

### Task 3: Resolve selected assets into bounded local references

**Files:**
- Modify: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`
- Modify: `apps/worker/src/handlers/plan-images.ts`
- Modify: `apps/worker/src/handlers/plan-images.test.ts`

**Interfaces:**
- Consumes: frozen selected asset IDs from Task 2.
- Produces: `loadPlanningContext()` with ordered `ResolvedImageReferenceV1[]`.

- [ ] **Step 1: Write failing tests**

Assert that planning receives local paths in the same order selected by the user and refuses missing/rejected/unreadable assets before calling the planner.

```ts
expect(planner.plan).toHaveBeenCalledWith(expect.objectContaining({
  references: [
    expect.objectContaining({ assetId: "asset_2", localPath: expect.stringContaining("asset-2") }),
    expect.objectContaining({ assetId: "asset_1", localPath: expect.stringContaining("asset-1") })
  ]
}));
```

- [ ] **Step 2: Run worker handler test and verify RED**

Run: `pnpm --filter @tk/worker test -- src/handlers/plan-images.test.ts`

Expected: FAIL because raw asset IDs are passed as `localImagePaths`.

- [ ] **Step 3: Implement ordered asset resolution**

Use `jsonb_array_elements_text(... WITH ORDINALITY)` or an equivalent ordered query. Return only owned ready assets with non-empty `local_path` and supported extensions. The Worker must pass resolved references and the full frozen recipe to the planner.

- [ ] **Step 4: Run worker and DB tests**

Run: `pnpm --filter @tk/worker test -- src/handlers/plan-images.test.ts && pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/image-generation-repository.ts packages/db/src/integration/repositories.integration.test.ts apps/worker/src/handlers/plan-images.ts apps/worker/src/handlers/plan-images.test.ts
git commit -m "fix: resolve headless source image references"
```

---

### Task 4: Preserve category templates and product truth in prompt planning

**Files:**
- Modify: `packages/adapters/src/image-generation/openai-image-planner.ts`
- Modify: `packages/adapters/src/image-generation/openai-image-planner.test.ts`
- Modify: `apps/worker/src/handlers/plan-images.ts`
- Modify: `apps/worker/src/handlers/plan-images.test.ts`

**Interfaces:**
- Consumes: complete frozen recipe, facts, and resolved references.
- Produces: exactly one `PlannedImagePromptV1` per output slot.

- [ ] **Step 1: Write failing planner request tests**

Inspect the outgoing `/chat/completions` body and assert it includes product title/category/attributes, `visualDirection`, `mustPreserve`, `forbidden`, and each ordered role instruction. Assert at least one encoded image is present when references are supplied.

- [ ] **Step 2: Run planner tests and verify RED**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-image-planner.test.ts`

Expected: FAIL because the current prompt receives only the reduced recipe and asset IDs cannot be encoded.

- [ ] **Step 3: Implement safe local-image encoding and complete prompt text**

Read local files with `node:fs/promises`, validate extension, magic bytes, and the 4 MiB per-image limit, then encode data URLs. Do not fetch `file://` URLs. Reject the planning request if a selected reference cannot be included.

- [ ] **Step 4: Run planner and Worker tests**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-image-planner.test.ts && pnpm --filter @tk/worker test -- src/handlers/plan-images.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/image-generation/openai-image-planner.ts packages/adapters/src/image-generation/openai-image-planner.test.ts apps/worker/src/handlers/plan-images.ts apps/worker/src/handlers/plan-images.test.ts
git commit -m "fix: apply category recipes to image planning"
```

---

### Task 5: Submit Agnes-compatible reference images with separate timeouts

**Files:**
- Modify: `packages/adapters/src/image-generation/openai-compatible-image-provider.ts`
- Modify: `packages/adapters/src/image-generation/openai-compatible-image-provider.test.ts`

**Interfaces:**
- Consumes: one slot prompt, 1-6 resolved references, frozen parameters, and idempotency key.
- Produces: synchronous output URL or asynchronous task ID without Canvas dependencies.

- [ ] **Step 1: Write failing provider tests**

Assert `extra_body.image` uses the Agnes-compatible array of bounded data URL strings in reference order. Add fake-timer cases proving a connection failure is bounded at 30 seconds while a connected long response may continue up to the configured 30-minute response bound.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-compatible-image-provider.test.ts`

Expected: FAIL because the current body uses image-message objects and one 30-second timer aborts the entire request.

- [ ] **Step 3: Implement the provider boundary**

Encode local references with the same bounded helper as Task 4. Use separate connection and response timeout controls. Preserve `image_submission_result_unknown` for disconnect, timeout, or invalid response after transmission; never automatically resubmit an unknown result.

- [ ] **Step 4: Run provider tests and adapter typecheck**

Run: `pnpm --filter @tk/adapters test -- src/image-generation/openai-compatible-image-provider.test.ts && pnpm --filter @tk/adapters typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/image-generation/openai-compatible-image-provider.ts packages/adapters/src/image-generation/openai-compatible-image-provider.test.ts
git commit -m "fix: submit bounded Agnes image references"
```

---

### Task 6: Archive generated output as a real ready asset

**Files:**
- Modify: `packages/db/src/assets/content-addressed-store.ts`
- Modify: `packages/db/src/assets/content-addressed-store.test.ts`
- Modify: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`
- Modify: `apps/worker/src/handlers/generate-image-slot.ts`
- Modify: `apps/worker/src/handlers/generate-image-slot.test.ts`

**Interfaces:**
- Produces: `ContentAddressedStore.archive()` including width and height.
- Produces: fenced `archiveSlotOutput()` that creates/reuses a ready asset and returns its asset ID.

- [ ] **Step 1: Write failing store and repository tests**

Assert PNG/JPEG dimensions are returned. Assert generated output creates a ready `assets` row with the slot batch product/revision, content SHA, local path, extension, and dimensions; assert the slot stores that row ID rather than the local path.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @tk/db test -- src/assets/content-addressed-store.test.ts`

Run: `pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts`

Expected: FAIL because dimensions and durable asset creation are missing.

- [ ] **Step 3: Implement dimensions and atomic asset persistence**

Parse PNG IHDR and supported JPEG SOF markers during/after bounded download. In one fenced database transaction, create or reuse the generated asset by revision and provider evidence/content identity, then transition the slot to `succeeded` with the returned asset ID. Remove the unimplemented `saveSlotQualityMetadata` interface or back it with explicit persisted columns; do not leave a mock-only repository method.

- [ ] **Step 4: Run store, repository, and Worker tests**

Run: `pnpm --filter @tk/db test -- src/assets/content-addressed-store.test.ts && pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts && pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/assets/content-addressed-store.ts packages/db/src/assets/content-addressed-store.test.ts packages/db/src/repositories/image-generation-repository.ts packages/db/src/integration/repositories.integration.test.ts apps/worker/src/handlers/generate-image-slot.ts apps/worker/src/handlers/generate-image-slot.test.ts
git commit -m "fix: persist generated images as ready assets"
```

---

### Task 7: Make slot retry and restart recovery contract-correct

**Files:**
- Modify: `packages/db/src/repositories/image-generation-repository.ts`
- Modify: `packages/db/src/integration/repositories.integration.test.ts`
- Modify: `apps/worker/src/handlers/generate-image-slot.ts`
- Modify: `apps/worker/src/handlers/generate-image-slot.test.ts`
- Modify: `e2e/worker-recovery.spec.ts`

**Interfaces:**
- Consumes: `ImageGenerateSlotJobPayloadV1`.
- Produces: retry jobs preserving slot number, payload version `1`, and incremented attempt.

- [ ] **Step 1: Write failing retry and restart tests**

Assert a retry of slot 4 queues `{ version: 1, slotNumber: 4, attempt: 1 }`. Assert persisted remote task recovery calls fetch without another submit. Assert a downloaded provider result retries archival without a new paid call.

- [ ] **Step 2: Run repository/Worker tests and verify RED**

Run: `pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts`

Run: `pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: FAIL because retry currently writes `slotNumber: 0`, uses attempt as schema version, and does not persist all slot checkpoints.

- [ ] **Step 3: Implement fenced transitions and checkpoints**

Persist slot remote task ID and remote output URL alongside job recovery data. Derive business keys from SHA-256 of the complete stable prompt and attempt, not base64 prefixes. Keep successful sibling slots untouched.

- [ ] **Step 4: Run focused restart coverage**

Run: `pnpm --filter @tk/worker test -- src/handlers/generate-image-slot.test.ts && pnpm --filter @tk/db test:integration -- repositories.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/image-generation-repository.ts packages/db/src/integration/repositories.integration.test.ts apps/worker/src/handlers/generate-image-slot.ts apps/worker/src/handlers/generate-image-slot.test.ts e2e/worker-recovery.spec.ts
git commit -m "fix: recover headless image slots safely"
```

---

### Task 8: Publish accepted assets with correct content identity

**Files:**
- Modify: `packages/adapters/src/publishing/asset-publishing-adapter.ts`
- Modify: `packages/adapters/src/publishing/asset-publishing-adapter.test.ts`
- Modify: `apps/worker/src/handlers/miaoshou-edit.ts`
- Modify: `apps/worker/src/handlers/miaoshou-edit.test.ts`

**Interfaces:**
- Consumes: ordered accepted ready assets.
- Produces: ordered HTTPS URLs with object key `images/<sha256>.<extension>`.

- [ ] **Step 1: Write failing publishing tests**

Use two different byte fixtures and assert different SHA-based keys, single-dot extensions, AWS SDK v3 `$metadata.httpStatusCode === 404` upload behavior, existing-object reuse, and ordered output.

- [ ] **Step 2: Run adapter test and verify RED**

Run: `pnpm --filter @tk/adapters test -- src/publishing/asset-publishing-adapter.test.ts`

Expected: FAIL because the hash ignores bytes, keys contain two dots, and v3 not-found metadata is ignored.

- [ ] **Step 3: Implement content-addressed publishing**

```ts
function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
const objectKey = `images/${sha256}${extension}`;
```

Handle both `$metadata.httpStatusCode` and provider-compatible not-found names without treating authentication or network failures as absence. Keep approval state when publishing/writeback fails so retry does not regenerate.

- [ ] **Step 4: Run publishing and Miaoshou tests**

Run: `pnpm --filter @tk/adapters test -- src/publishing/asset-publishing-adapter.test.ts && pnpm --filter @tk/worker test -- src/handlers/miaoshou-edit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/publishing/asset-publishing-adapter.ts packages/adapters/src/publishing/asset-publishing-adapter.test.ts apps/worker/src/handlers/miaoshou-edit.ts apps/worker/src/handlers/miaoshou-edit.test.ts
git commit -m "fix: publish approved images by content hash"
```

---

### Task 9: Complete production Worker composition and preserve Canvas rollback

**Files:**
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/entry.ts`
- Modify: `apps/worker/src/composition.test.ts`
- Modify: `apps/worker/src/cli.test.ts`
- Modify: `packages/adapters/src/factory.ts`
- Modify: `packages/adapters/src/factory.test.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`

**Interfaces:**
- Consumes: repositories and provider ports completed in Tasks 1-8.
- Produces: production `createWorkerApplication()` that compiles and can run both explicit routing modes.

- [ ] **Step 1: Write failing composition tests**

Assert production composition supplies `imageGeneration`, `imageSlot`, `publishing`, and `imageGeneration` adapter limits. Assert explicit `canvas` still enqueues `canvas_generate`; explicit `headless` stops at readiness until the product command creates a batch.

- [ ] **Step 2: Run Worker/config tests and verify RED**

Run: `pnpm --filter @tk/worker test -- src/composition.test.ts src/cli.test.ts && pnpm --filter @tk/config test -- src/env.test.ts`

Expected: FAIL because production entry omits repositories/limits and existing test fixtures do not satisfy new ports.

- [ ] **Step 3: Implement one complete composition root**

Instantiate `ImageGenerationRepository` once and inject it through exported repository adapters rather than test-only object shapes. Add the image-generation limiter and pass `imageGenerationPath` to selection routing. Update every test fixture to compile against the production registry input.

- [ ] **Step 4: Run Worker, adapter, and config gates**

Run: `pnpm --filter @tk/worker test && pnpm --filter @tk/worker typecheck && pnpm --filter @tk/adapters test && pnpm --filter @tk/config test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/main.ts apps/worker/src/entry.ts apps/worker/src/composition.test.ts apps/worker/src/cli.test.ts packages/adapters/src/factory.ts packages/adapters/src/factory.test.ts packages/config/src/env.ts packages/config/src/env.test.ts
git commit -m "fix: compose the headless worker runtime"
```

---

### Task 10: Verify Web projection, partial acceptance, and gallery behavior

**Files:**
- Modify: `apps/web/src/server/services/image-generation-service.ts`
- Modify: `apps/web/src/server/services/image-generation-service.test.ts`
- Modify: `apps/web/src/server/services/product-service.ts`
- Modify: `apps/web/src/server/services/product-service.test.ts`
- Modify: `apps/web/src/components/products/image-generation-panel.tsx`
- Modify: `apps/web/src/components/products/image-generation-panel.test.tsx`

**Interfaces:**
- Consumes: ready asset IDs and ordered slot projection.
- Produces: server-backed original/generated separation, single-slot retry/exclude, and ordered partial acceptance.

- [ ] **Step 1: Write failing service/component tests**

Assert accepted slot IDs are unique, belong to the current batch, are succeeded and non-excluded, and preserve user order. Assert generated thumbnails resolve from ready local assets, never provider URLs, and remain separate from originals.

- [ ] **Step 2: Run Web tests and verify RED**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts src/server/services/product-service.test.ts src/components/products/image-generation-panel.test.tsx`

Expected: FAIL for any projection still relying on invalid paths or insufficient partial-acceptance validation.

- [ ] **Step 3: Implement minimal projection corrections**

Resolve archived asset IDs through the asset read model. Reject duplicate/foreign/non-successful ordered slot IDs. Preserve current concise UI and three-second server refresh behavior; do not redesign the page.

- [ ] **Step 4: Run focused Web tests and typecheck**

Run: `pnpm --filter @tk/web test -- src/server/services/image-generation-service.test.ts src/server/services/product-service.test.ts src/components/products/image-generation-panel.test.tsx && pnpm --filter @tk/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/services/image-generation-service.ts apps/web/src/server/services/image-generation-service.test.ts apps/web/src/server/services/product-service.ts apps/web/src/server/services/product-service.test.ts apps/web/src/components/products/image-generation-panel.tsx apps/web/src/components/products/image-generation-panel.test.tsx
git commit -m "fix: project durable headless image results"
```

---

### Task 11: Clear repository-wide static and automated gates

**Files:**
- Modify only files identified by failing commands, with each change tied to the correction scope.
- Test: existing workspace lint, typecheck, build, unit, integration, and E2E suites.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: a buildable, testable branch before any live provider call.

- [ ] **Step 1: Run static gates and record exact failures**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

Expected: identify any remaining integration mistakes; do not suppress rules or loosen types to pass.

- [ ] **Step 2: Fix one static failure class at a time**

For each failure, add or adjust the narrowest relevant test first when behavior changes, then correct the production code. Remove unused imports/variables rather than disabling lint.

- [ ] **Step 3: Run unit and integration gates**

Run:

```bash
pnpm test
pnpm test:integration
```

Expected: both exit 0 without hangs. Investigate the existing Web product-safety failure and extension page-context timeout from their actual failing layer; do not mark them unrelated without evidence.

- [ ] **Step 4: Run Canvas-off Mock E2E**

Run:

```bash
pnpm test:e2e -- e2e/headless-image-generation.spec.ts e2e/worker-recovery.spec.ts
```

Expected: PASS with no live provider calls, including `1->1`, `3->5`, `4->5`, `6->8` and restart checkpoints.

- [ ] **Step 5: Run final non-live gate**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e -- e2e/headless-image-generation.spec.ts e2e/worker-recovery.spec.ts
git diff --check
git status --short
```

Expected: all commands exit 0; status contains no corrective changes and only the pre-existing untracked agent reports.

- [ ] **Step 6: Commit any final scoped corrections**

Stage only the exact files changed while resolving recorded Task 11 failures, inspect `git diff --cached --stat`, then commit them:

```bash
git diff --name-only
git diff --cached --stat
git commit -m "test: close headless image generation gates"
```

---

### Task 12: Run controlled local production and live-provider acceptance

**Files:**
- Modify: `docs/operations/headless-image-generation.md` only if verified commands or recovery behavior changed.
- Create: `docs/superpowers/reports/2026-08-03-headless-image-generation-correction-verification.md`

**Interfaces:**
- Consumes: a completely green non-live branch from Task 11.
- Produces: runtime and live evidence required to promote `headless` as verified.

- [ ] **Step 1: Start with the repository script and verify services**

Run the repository-owned local production startup command documented in `package.json`/`docs/operations/local-production.md`. Verify PostgreSQL, Web, and Worker health and open `http://127.0.0.1:3000/products/` plus one product detail page.

- [ ] **Step 2: Perform Canvas-off Mock acceptance**

With Infinite-Canvas stopped and mock providers enabled, prove selection, requested slot count, generation progress, ready local assets, original/generated gallery separation, partial acceptance, approval, and mock Miaoshou writeback.

- [ ] **Step 3: Request explicit approval for one paid real-provider batch**

Report the model, expected number of image calls, selected product, input count, output count, and maximum cost exposure. Do not proceed without user confirmation.

- [ ] **Step 4: Run one bounded real-provider batch after approval**

Record input asset IDs, provider call count, latency, prompt/template version, output URLs, archived asset IDs, dimensions, SHA-256 values, approval order, and Miaoshou writeback result. Infinite-Canvas remains stopped.

- [ ] **Step 5: Write and self-review the verification report**

The report must map every delivery gate in the correction design to current command output, database/runtime evidence, or screenshots. Mark missing or indirect evidence as not achieved.

- [ ] **Step 6: Commit verified operations evidence**

```bash
git add docs/operations/headless-image-generation.md docs/superpowers/reports/2026-08-03-headless-image-generation-correction-verification.md
git commit -m "docs: verify corrected headless image generation"
```

---

## Plan Self-Review Checklist

- Every correction-design invariant maps to at least one task and one verification command.
- Contracts flow from Task 1 through repository, adapters, Worker composition, Web projection, and E2E without duplicate interface definitions.
- No task stores local paths or URLs in asset-ID fields.
- No task removes Canvas compatibility.
- No live provider call occurs before the complete non-live gate.
- Every implementation task has a failing-test step, passing-test step, and scoped commit.
