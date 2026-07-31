# Headless Image Generation Pipeline Design

## 1. Goal

Replace Infinite-Canvas as the production image-generation runtime with a lightweight, persistent pipeline inside the existing TK Commerce Workbench worker.

The replacement must preserve the current business outcome:

1. Select archived source product images.
2. Analyze product facts and create category-aware image prompts.
3. Generate a requested number of processed product images.
4. Archive every successful result locally.
5. Let the user review original and processed images separately.
6. Write approved images back to the same canonical Miaoshou collect-box item through a transport that is independent of Canvas.

The daily user experience must stay practical: choose images, choose output count, start generation, review results. It must not expose workflow nodes or require drag-and-drop editing.

## 2. Confirmed Product Decisions

- Infinite-Canvas is removed from the production execution path.
- Infinite-Canvas may remain as a separate development tool for experimenting with prompts and models.
- No new standalone Python service is introduced.
- The existing TypeScript worker, PostgreSQL job system, and local content-addressed asset store remain the production foundation.
- Users can control which local source images are used and how many processed images are requested.
- Image planning is category-aware and uses versioned prompt templates.
- All users can create, edit, test, activate, archive, and roll back templates. There is no administrator/operator role split.
- Editing an active template creates a new draft version rather than overwriting an active version.
- Every generated image is an independent slot with its own status and retry history.
- A failed slot must not regenerate successful slots.
- Partial results can be reviewed and accepted.
- Miaoshou writeback must not depend on Canvas asset URLs.

## 3. Why the Current Canvas Runtime Is Not the Target Architecture

The exported workflow `TK-20260731T150751.json` contains 21 nodes and 16 connections, but the production behavior is only:

```text
input product images
  -> one LLM prompt-planning node
  -> one JSON prompt splitter
  -> five equivalent image-generation nodes
  -> one output collector
```

The export also contains presentation and runtime residue that is not part of the business rule:

- image placeholders and a visual group;
- canvas coordinates and dimensions;
- 9,640 characters of a previous LLM response;
- 5,211 characters of previously split prompts;
- 20 cached generated-output entries;
- two dangling group-item references.

The current workflow hard-codes two to five inputs in its system prompt and hard-codes five outputs by placing five generator nodes. It therefore does not naturally support dynamic output count.

The full Infinite-Canvas application is also much broader than this use case. It combines the visual canvas, multiple image and video providers, local ComfyUI, RunningHub, Jimeng CLI, asset management, WebSockets, internationalized UI, and automation execution. Its automation task state is held in process memory and is lost on restart. Its license permits personal/company use but restricts repackaging as a commercial product and requires derived software to remain open source and credit the author.

The new implementation will reproduce the required business behavior through provider contracts and fresh workbench code. It will not copy the Infinite-Canvas runtime implementation.

## 4. Target Architecture

```text
Product detail UI
  -> generation request and frozen input selection
  -> versioned category recipe
  -> prompt planning job
  -> M independent generation-slot jobs
  -> local validation and content-addressed archive
  -> product image review
  -> approval
  -> Miaoshou publishing transport
```

### 4.1 Product detail UI

The product detail page owns the simple user command surface:

- inferred category, with manual override;
- selected input-image thumbnails;
- output-image count;
- one primary `开始洗图` action.

It reads persisted batch and slot state. It does not maintain an optimistic `in progress` state without refreshing the server projection.

### 4.2 Generation recipe service

The recipe service resolves the active category template and freezes the exact recipe version into a new batch. It does not execute model calls.

### 4.3 Prompt planner adapter

The planner calls the configured multimodal LLM with:

- the global product-truth and safety rules;
- the resolved category template;
- frozen product facts;
- the selected local images;
- the requested output count and ordered output roles.

It returns a strictly validated structured response containing exactly one prompt per output slot.

### 4.4 Image provider adapter

The image adapter accepts one slot prompt, frozen model parameters, and the approved reference-image set. Provider-specific submission and polling are contained behind this adapter.

### 4.5 Existing worker and job repository

The existing worker remains responsible for leases, retry scheduling, idempotency, remote-result reconciliation, and restart recovery. Planning and every image slot are separate jobs.

### 4.6 Existing local asset store

Every successful provider result is downloaded, validated, hashed, and archived before the slot becomes successful. Remote URLs are evidence of origin, not the durable result.

### 4.7 Miaoshou publishing transport

Publishing approved local assets is a separate boundary. It may use a Miaoshou-native upload API or stable object storage, but it must not upload to Canvas or use Canvas as public image hosting.

## 5. Data Model

Names below describe the business entities; the implementation plan may fit them into existing tables where that preserves current repository conventions.

### 5.1 Image generation template

An `image_generation_template` stores the stable template identity and category mapping.

Required facts:

- template ID and human-readable name;
- category key and optional parent category;
- active version ID;
- enabled/archived state;
- timestamps.

### 5.2 Template version

An immutable `image_generation_template_version` stores:

- version number and draft/active/archived state;
- default, minimum, and maximum input count;
- default, minimum, and maximum output count;
- global/category product-preservation rules;
- visual direction;
- forbidden claims and forbidden visual changes;
- ordered output-role definitions;
- planner provider/model and prompt template;
- image provider/model, ratio, resolution, quality, and concurrency;
- creation timestamp.

First-version guardrails are one to six input images and one to eight output images.

Only one version per template is active. Editing an active version creates a new draft. Activation changes which version future batches resolve; it does not mutate existing batches.

### 5.3 Generation batch

An immutable `image_generation_batch` freezes:

- product and revision IDs;
- selected source asset IDs in order;
- requested output count;
- inferred and user-confirmed category;
- template and template-version IDs;
- planner provider/model configuration snapshot;
- image provider/model configuration snapshot;
- product-fact snapshot and its digest;
- batch status and timestamps.

Changing product facts, selected images, category, template, or output count creates a new batch rather than changing a running batch.

### 5.4 Generation slot

Each `image_generation_slot` stores:

- batch ID and one-based slot number;
- semantic role such as `hero`, `benefit`, `scene`, `detail`, or `audience`;
- validated prompt, preservation facts, and forbidden facts;
- prompt hash;
- provider request identity and remote task ID;
- status, attempt count, and safe error;
- generated remote URL evidence;
- archived local asset ID;
- timestamps.

The stable business key includes the product revision, template version, slot number, and prompt hash. Repeated clicks for the same successful key must not cause another paid generation.

## 6. Category Template Resolution

Templates use category fallback rather than duplicating every rule:

```text
generic product
  -> apparel accessory
    -> hat
      -> women's hat
```

The workbench first maps captured source attributes to an internal category. The user may change the category before starting a batch. Resolution selects the most specific active template and falls back through parent categories to the generic template.

Prompt composition order is:

```text
verified product facts
  > category preservation and prohibition rules
  > category visual direction
  > generic visual defaults
```

Visual style must never override verified product shape, color, structure, packaging, visible text, or usage facts.

### 6.1 Planner response

The planner must return exactly the requested number of items:

```json
{
  "prompts": [
    {
      "slot": 1,
      "role": "hero",
      "prompt": "Concrete image-generation instruction",
      "mustPreserve": ["verified product fact"],
      "forbidden": ["unverified or prohibited change"]
    }
  ]
}
```

Validation rejects:

- invalid JSON;
- missing, duplicate, or non-contiguous slot numbers;
- a prompt count different from the requested count;
- empty or over-limit prompts;
- missing mandatory preservation facts;
- unverified material, certification, performance, price, or endorsement claims.

Invalid planner output is repaired or retried before any image generation begins.

### 6.2 Output-role selection

The template defines roles in priority order. For fewer outputs, the planner uses the first M required roles. For more outputs, it appends template-defined variants such as additional scenes, SKU/color presentation, packaging, or another detail view.

## 7. User Experience

### 7.1 Daily product flow

The product detail page presents one compact panel:

```text
category: women's hat (inferred) [change]
input images: selected thumbnail strip
output count: [-] 5 [+]
[start generation]
```

Defaults should make the common path a single click. The daily interface does not expose provider names, concurrency, task IDs, raw error codes, node graphs, or full prompts.

### 7.2 Progress and partial results

The same panel becomes a live server-backed progress view:

```text
generated 4/5
[hero done] [benefit done] [scene done] [detail retrying] [audience done]
```

Successful images appear immediately. For each processed image, the only daily actions are:

- enlarge;
- regenerate this image;
- exclude this image.

When fewer images succeed than requested, users may continue retrying, retry one image manually, accept the current successful set, or abandon the batch.

### 7.3 Human-readable states

The UI uses business language:

- analyzing product images;
- preparing five images;
- generated three of five;
- image four is retrying, attempt two of three;
- completed four of five, current results may be used;
- model configuration needs attention.

Technical codes and provider responses remain available in diagnostics and audit records.

### 7.4 Template management for every user

There is no role-based restriction. Every user can:

- create and edit templates;
- duplicate templates;
- run prompt-only tests;
- activate a draft version;
- archive a template;
- restore a previous version.

The template list shows category, active version, default input/output counts, and simple test/edit actions. The editor exposes only:

- template name and category;
- default input/output counts;
- must-preserve rules;
- visual direction;
- forbidden content;
- ordered output roles.

Provider and model parameters live in a collapsed advanced section.

A prompt-only test selects an existing product and previews planner output without spending image-generation quota.

## 8. Execution and Recovery

### 8.1 Batch creation

Starting generation transactionally creates:

1. the immutable batch;
2. one planner job;
3. the expected slot records.

Image jobs are not released until planner output passes validation and is persisted.

### 8.2 Planner recovery

- Network errors and provider 429/502/503 responses use bounded exponential backoff.
- Invalid structured output is repaired or replanned without calling the image provider.
- Authentication, missing model, and invalid configuration failures stop and require configuration correction.
- The default automatic attempt limit is three.

### 8.3 Slot recovery

Slots retry independently. A failed slot never resets successful sibling slots or reruns the planner.

Before a non-transactional provider submission, the worker persists reconciliation intent. Once the provider accepts a task, its remote task ID is persisted immediately. After restart or an unknown response, the worker queries that task before creating another paid request.

### 8.4 Result archival

A provider result becomes successful only after the worker:

1. downloads it;
2. verifies a supported image type;
3. verifies non-empty decodable bytes and size limits;
4. records dimensions, byte count, and SHA-256;
5. stores it in the local content-addressed archive;
6. persists the local asset ID on the slot.

Provider result download may retry without regenerating the image when a stable remote task or result identity exists.

### 8.5 Basic quality gates

Automated gates cover decodability, dimensions, empty files, exact duplicate content, and highly similar sibling output. Product fidelity, color correctness, and commercial suitability remain explicit human-review decisions.

## 9. Migration

### Phase 1: build the headless pipeline

Add the recipe, batch, and slot boundaries to the existing workbench and implement fresh planner/image provider adapters. Do not modify the existing Canvas path yet.

### Phase 2: seed initial templates

Use the current workflow's general ecommerce safety and planning behavior as a functional reference. Create clean generic and initial category templates without importing coordinates, cached results, placeholder nodes, or jewelry-specific runtime output.

### Phase 3: parallel validation

Run old and new paths against a small real sample covering women's hats, jewelry, and apparel. Compare input evidence, prompt quality, output count, fidelity, latency, provider-call count, restart recovery, and local archive completeness.

Required count scenarios include:

- one input to one output;
- three inputs to five outputs;
- four inputs to five outputs;
- six inputs to eight outputs.

### Phase 4: switch new production work

New batches use the headless pipeline by default. Existing Canvas tasks may finish. Existing generated images remain valid and are not regenerated or migrated.

### Phase 5: remove Canvas production dependencies

After the acceptance gate, remove production reliance on Canvas workflow IDs, Canvas upload, Canvas task polling, Canvas output URL availability, and Canvas staging for Miaoshou writeback.

## 10. Testing Strategy

### Unit tests

- category fallback and active-version resolution;
- template version immutability;
- input/output count guardrails;
- exact planner schema and count validation;
- output-role selection for variable M;
- slot business-key stability;
- safe error mapping and retry classification;
- duplicate-image detection.

### Database integration tests

- batch, planner job, and slot creation is atomic;
- template activation does not mutate existing batches;
- repeated start commands are idempotent;
- successful slots survive sibling failure;
- expired leases are safely reclaimed;
- remote task IDs survive restart;
- accepting partial output preserves successful asset order.

### Worker integration tests

- malformed planner JSON is repaired before image calls;
- prompt-count mismatch does not spend image quota;
- one slot retries without rerunning siblings;
- unknown provider submission result reconciles before resubmission;
- result download retries without new generation;
- every successful slot references a ready local asset.

### Browser tests

- the common path needs only category/input/output confirmation and one start action;
- progress refreshes from server state;
- original and processed images remain separate;
- partial output is visible and actionable;
- one image can be regenerated or excluded;
- every user can manage template versions;
- prompt-only testing does not start image jobs.

### Live acceptance

- run the required category and count matrix against real providers;
- restart the worker during planning, generation, polling, and download;
- verify that no successful paid slot is regenerated;
- verify that all accepted images remain visible with Canvas stopped;
- verify Miaoshou writeback with Canvas unavailable.

## 11. Acceptance Criteria

- Requested output count is represented by exactly that many persistent slots.
- Service restart loses no batch, slot, remote task, or successful local asset state.
- Successful slots are never regenerated because another slot failed.
- Every successful image is locally archived before review.
- Users can regenerate or exclude one image without affecting siblings.
- The UI shows persisted server truth rather than permanent optimistic progress.
- Template changes create versions and never alter running or completed batches.
- All users have the same template-management capabilities.
- The complete generation and review path works while Infinite-Canvas is stopped.
- Miaoshou writeback does not require Canvas-hosted images.
- Existing source images, generated images, approvals, and audit history remain intact during migration.

## 12. Non-goals

- Rebuilding an infinite canvas or node editor.
- Allowing arbitrary user-authored execution graphs.
- Running image foundation models on local GPU hardware.
- Replacing the existing workbench database, worker, review page, or local asset store.
- Automatically publishing products to a shop without explicit approval.
- Automatically deciding product fidelity or commercial suitability without human review.
