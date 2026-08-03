# Headless Image Generation Correction Design

## 1. Purpose

Correct the incomplete `feat/headless-image-gen` implementation without replacing the approved product experience or discarding the persistent batch-and-slot model.

The corrected path must support this complete business flow with Infinite-Canvas stopped:

```text
selected ready source assets
  -> resolved local reference images and frozen product facts
  -> category-aware prompt plan
  -> independent image-generation slots
  -> validated local assets
  -> ordered review and approval
  -> HTTPS publishing
  -> Miaoshou writeback
```

Legacy `canvas` routing remains available as an explicit rollback path. `headless` must not be treated as production-ready until every release gate in this document passes.

## 2. Considered Approaches

### A. Patch only the current TypeScript errors

This is the smallest change, but it would leave the asset-ID/path confusion, ignored template instructions, missing reference images, and invalid publishing identity intact. It is rejected because a green build would still not prove a correct wash-image workflow.

### B. Replace the headless implementation completely

This could produce cleaner code but would discard useful work: persistent batches, independent slots, template lifecycle, UI commands, and recovery contracts. It creates unnecessary migration and regression risk. It is rejected.

### C. Correct the execution boundaries in dependency order

Keep the existing product model and rebuild the broken boundaries from the asset layer upward. Each correction is test-first, independently committed, and verified before the next boundary changes. This is the selected approach.

## 3. Non-Negotiable Invariants

### 3.1 Asset identity

- An asset ID is a database identity and is never used as a filesystem path or public URL.
- A local path belongs to a ready `assets` row and never becomes an `archived_asset_id` value.
- A remote provider URL is transient evidence and never becomes the durable result.
- Every successful slot references one ready local asset row.
- SHA-256 is calculated from the actual bytes and is the content-addressing identity.

### 3.2 Frozen generation input

Every batch freezes, in user-selected order:

- product ID and revision ID;
- selected source asset IDs;
- product facts and digest;
- category and exact active template version;
- full recipe, including preservation rules, forbidden rules, visual direction, role instructions, and provider parameters;
- requested output count.

The repository validates that all selected assets are ready and belong to the requested product revision. The worker resolves those IDs into bounded local image inputs before either planning or generation.

### 3.3 Prompt and reference-image flow

The planner receives the full frozen recipe, frozen product facts, and selected local images. It returns exactly one validated prompt per requested slot.

Every image-generation slot receives the same approved reference-image set plus its own prompt and frozen model parameters. Reference images are encoded in the exact Agnes-compatible representation verified by adapter contract tests. Prompt-only generation is not a valid production fallback when references cannot be resolved.

### 3.4 Slot state and recovery

Slot state changes follow explicit transitions:

```text
waiting_for_plan -> queued -> submitting -> polling -> archiving -> succeeded
                                      |          |          |
                                      +----------+----------+-> failed
```

- Slot numbers are one-based and remain stable across retries.
- Payload schema version remains `1`; retry attempt is a separate value.
- Provider request identity and remote task ID are persisted before polling.
- A known remote task is polled after restart and is never automatically resubmitted.
- Download or archive retry does not create another paid generation.
- A failed sibling never reruns a successful slot.

### 3.5 Local archival

The content-addressed store downloads a bounded PNG or JPEG, validates magic bytes, determines dimensions, calculates SHA-256, and stores the file atomically.

An asset repository then creates or reuses a ready `assets` row for that content. Only the resulting asset ID may be written to `image_generation_slots.archived_asset_id`.

Quality metadata belongs either to the local asset record or to explicitly defined slot columns. The Worker interface must not expose repository methods that have no database implementation.

### 3.6 Publishing and Miaoshou writeback

Only accepted ready local assets are publishable. Publishing:

- reads files below the configured asset root;
- computes SHA-256 from file bytes;
- uses a single-dot extension in the object key;
- handles AWS SDK v3 `HeadObject` not-found metadata correctly;
- uploads only when the content object is absent;
- returns HTTPS URLs in the accepted order.

Miaoshou writeback consumes these published URLs and does not use Canvas staging or Canvas-hosted output URLs.

## 4. Component Boundaries

### 4.1 Web command service

Responsibilities:

- validate input/output counts and duplicate selections;
- verify product, revision, and source-asset ownership;
- resolve the active category template;
- load real immutable product facts;
- create an idempotent frozen batch.

It does not convert image bytes or call model providers.

### 4.2 Image generation repository

Responsibilities:

- persist batches, slots, provider identities, attempts, errors, and accepted order;
- return resolved source-asset metadata needed by workers;
- enforce fenced state transitions;
- create or reuse archived asset records transactionally where required;
- enqueue planner and slot jobs with versioned payloads.

Repository method signatures are shared by Web and Worker through exported interfaces rather than duplicated structural approximations.

### 4.3 Prompt planner adapter

Responsibilities:

- encode bounded local images;
- send the full frozen recipe and facts;
- validate strict structured output;
- perform at most one schema-repair request;
- classify authentication, rate-limit, timeout, schema, and transient failures without exposing secrets.

### 4.4 Image provider adapter

Responsibilities:

- accept one prompt, 1-6 resolved reference images, frozen parameters, and a stable client request key;
- use a 30-second connection bound and a separate bounded response duration up to 30 minutes;
- parse one synchronous output URL or one asynchronous task ID;
- treat an unknown submit result as reconciliation-required rather than resubmitting;
- poll asynchronous tasks without Canvas assumptions.

### 4.5 Worker composition

The production entry constructs and injects all required repositories, ports, and adapter limits. The same registry shape is used by composition tests and production startup so a passing test cannot omit dependencies required at runtime.

## 5. Error Handling and User-Visible Behavior

- Missing or non-owned input image: generation does not start; the page identifies the invalid selection.
- Reference resolution failure: the affected batch stops before a paid image call.
- Unknown submission result: the slot shows that reconciliation is required and is not automatically retried.
- Provider still processing: the slot remains pending and is polled with bounded backoff.
- Download failure: retry archival using the existing provider result.
- Duplicate generated bytes: keep one ready asset identity and mark duplicate output visibly without corrupting sibling slots.
- Partial success: users may accept a non-empty ordered subset of succeeded, non-excluded slots.
- Publishing failure: approval remains intact and writeback may be safely retried without regenerating images.

Original and generated galleries remain visually separate throughout these states.

## 6. Test Strategy

Every correction follows red-green-refactor and gets its own commit.

### Contract and repository tests

- asset IDs resolve to owned ready local paths;
- cross-revision asset selection is rejected;
- slot success stores a real ready asset ID;
- retries preserve one-based slot number and payload version `1`;
- remote task and archive checkpoints survive worker restart;
- accepted partial output preserves explicit successful order.

### Adapter tests

- planner receives images, complete recipe, and facts;
- provider receives 1-6 bounded Agnes-compatible reference images;
- connection and long-response timeouts are independently classified;
- publishing hashes real bytes, produces `hash.png`, handles AWS v3 404, and preserves order.

### Composition and end-to-end tests

- production Worker composition typechecks with every new dependency;
- `IMAGE_GENERATION_PATH=canvas` preserves legacy routing;
- `IMAGE_GENERATION_PATH=headless` runs without Infinite-Canvas;
- count scenarios `1->1`, `3->5`, `4->5`, and `6->8` persist the requested number of slots;
- generated assets appear locally, remain separate from originals, can be accepted, and feed Miaoshou writeback;
- restart checkpoints cover planning, submitting/polling, downloading, and publishing.

## 7. Delivery Gates

The correction is not complete until all of the following are proven from the current branch:

1. `pnpm lint` exits 0.
2. `pnpm typecheck` exits 0.
3. `pnpm build` exits 0.
4. `pnpm test` exits 0 without hanging.
5. `pnpm test:integration` exits 0.
6. Headless and worker-recovery E2E tests exit 0 with no live provider calls.
7. The repository startup script serves `/products/` and the target product detail flow.
8. Canvas-off Mock acceptance proves the full local asset and writeback path.
9. After explicit user confirmation, one bounded real-provider batch proves fidelity, output count, local archival, approval, and Miaoshou writeback.
10. `git diff --check` passes and the corrective branch contains no unrelated files.

Until gates 1-8 pass, no real paid model call is made. Until gate 9 passes, `headless` is not promoted as the verified production default.
