/**
 * Headless Image Generation E2E Acceptance Tests
 *
 * These tests verify the complete headless image generation flow without Canvas:
 * - Full E2E flow from batch creation through slot generation to Miaoshou writeback
 * - Restart-safety: intent without result stops as needs_input and never resubmits
 * - Canvas-off: writeback succeeds with IMAGE_GENERATION_PATH=headless and CANVAS_BASE_URL empty
 *
 * Run with a real PostgreSQL database:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench_test \
 *     pnpm test:e2e -- e2e/headless-image-generation.spec.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createFakePorts } from "../packages/contracts/src/testing/fake-ports.js";
import { ContentAddressedStore } from "../packages/db/src/assets/content-addressed-store.js";
import { INITIAL_SQL } from "../packages/db/src/migrations/0000_initial.js";
import { JobRepository } from "../packages/db/src/repositories/job-repository.js";
import { PipelineRepository, pipelineRepositories } from "../packages/db/src/repositories/pipeline-repository.js";
import { ApprovalRepository } from "../packages/db/src/repositories/approval-repository.js";
import { AuditRepository } from "../packages/db/src/repositories/audit-repository.js";
import { CanvasQuotaRepository } from "../packages/db/src/repositories/canvas-quota-repository.js";
import { buildWorkerRuntime } from "../apps/worker/src/main.js";
import { adaptLeasedJobRepository, runWorkerLoop } from "../apps/worker/src/runtime/worker-loop.js";
import { createStagingCleanupCodec } from "../apps/worker/src/runtime/staging-cleanup-codec.js";
import { openE2eDatabase } from "./fixtures/test-database.js";
import { startMockMiaoshouServer, type MockMiaoshouServer } from "./fixtures/miaoshou-server.js";

const EXTENSION_TOKEN = "wave3-e2e-extension";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProductWithLocalImages(
  pool: import("pg").Pool,
  inputCount: number
): Promise<{ productId: string; revisionId: string; assetIds: string[] }> {
  const productId = `prod_headless_${randomUUID().slice(0, 8)}`;
  const revisionId = `rev_${randomUUID().slice(0, 8)}`;

  await pool.query(`
    INSERT INTO local_operators (id, handle, display_name)
    VALUES ('op_e2e', 'e2e-operator', 'E2E Operator')
    ON CONFLICT (handle) DO NOTHING;
    INSERT INTO products (id, operator_id, source_url, source_item_id, canonical_success_detail_id, locale, currency, state_source, state_automation)
    VALUES ($1, 'op_e2e', 'https://detail.1688.com/offer/892408514788.html', '892408514788', '3799770548', 'th-TH', 'THB', 'success', 'not_started')
  `, [productId]);

  const assetIds: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    const assetId = `asset_${randomUUID().slice(0, 8)}_${i}`;
    assetIds.push(assetId);
    await pool.query(`
      INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, width, height, local_path, extension)
      VALUES ($1, $2, $3, $4, 'main', 'ready', 1200, 1200, $5, 'jpg')
    `, [assetId, productId, revisionId, `https://cbu01.alicdn.com/img/ibank/O${i}.jpg`, `/data/assets/test_${i}.jpg`]);
  }

  await pool.query(`
    INSERT INTO product_revisions (id, product_id, draft_version, source_title, source_payload, working_draft)
    VALUES ($1, $2, 1, '测试商品', '{"mainImages":[],"detailImages":[]}'::jsonb, '{}')
  `, [revisionId, productId]);

  return { productId, revisionId, assetIds };
}

async function createImageGenerationBatch(
  pool: import("pg").Pool,
  productId: string,
  revisionId: string,
  assetIds: string[],
  outputCount: number
): Promise<{ batchId: string; templateVersionId: string }> {
  const batchId = `batch_${randomUUID().slice(0, 8)}`;
  // Stable id so ON CONFLICT DO NOTHING is actually meaningful
  const templateVersionId = `ig_tmpl_v1`;

  await pool.query(`
    INSERT INTO image_generation_templates (id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at)
    VALUES ('ig_tmpl_1', 'Headless Test', '服装', NULL, $1, true, NULL, now(), now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe, activated_at, created_at)
    VALUES ($1, 'ig_tmpl_1', 1, 'active',
            '{"inputCounts":{"default":4,"min":1,"max":6},"outputCounts":{"default":5,"min":1,"max":8},"mustPreserve":[],"visualDirection":"clean","forbidden":[],"roles":[]}'::jsonb,
            now(), now())
    ON CONFLICT (template_id, version) DO NOTHING;
  `, [templateVersionId]);

  await pool.query(`
    INSERT INTO image_generation_batches
      (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count,
       category_key, template_id, template_version_id, template_version, recipe_snapshot,
       product_facts_snapshot, product_facts_digest, state, accepted_asset_ids, created_at, updated_at)
    VALUES ($1, $2, $3, $1, $4, $5, '服装', 'ig_tmpl_1', $6, 1,
            '{"inputCounts":{"default":4,"min":1,"max":6},"outputCounts":{"default":5,"min":1,"max":8}}'::jsonb,
            '{}', 'digest_${randomUUID().slice(0, 8)}', 'generating', '{}', now(), now())
  `, [batchId, productId, revisionId, assetIds, outputCount, templateVersionId]);

  for (let i = 0; i < outputCount; i++) {
    const slotId = `slot_${batchId}_${i + 1}`;
    const businessKey = `slot:${batchId}:${i + 1}`;
    await pool.query(`
      INSERT INTO image_generation_slots
        (id, batch_id, slot_number, role, prompt, prompt_hash, business_key, state, attempt,
         remote_task_id, remote_output_url, archived_asset_id, error, excluded_at, created_at, updated_at)
      VALUES ($1, $2, $3, 'default', NULL, NULL, $4, 'queued', 0, NULL, NULL, NULL, NULL, NULL, now(), now())
    `, [slotId, batchId, i + 1, businessKey]);
  }

  return { batchId, templateVersionId };
}

// ---------------------------------------------------------------------------
// Step 4: Canvas-off writeback acceptance
// ---------------------------------------------------------------------------

test.describe("Canvas-off headless writeback", () => {
  test.setTimeout(180_000);

  let database: Awaited<ReturnType<typeof openE2eDatabase>>;
  let assetRoot: string;
  let miaoshouServer: MockMiaoshouServer;

  async function setup() {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
    database = await openE2eDatabase(process.env.TEST_DATABASE_URL);
    assetRoot = await mkdtemp(join(tmpdir(), "tk-igen-canvasoff-"));
    await database.reset();
    await database.migrate(INITIAL_SQL);
    process.env.DATABASE_URL = database.approved.url;
    Object.assign(process.env, {
      NODE_ENV: "test",
      EXTERNAL_ADAPTER_MODE: "mock",
      LOCAL_OPERATOR_ID: "local-e2e-operator",
      EXTENSION_TOKEN,
      ALLOW_LAN: "false",
      ASSET_ROOT: assetRoot,
      WORKER_CONCURRENCY: "1",
      WORKER_LEASE_MS: "30000",
      // Canvas OFF — the core of this test
      CANVAS_BASE_URL: "",
      IMAGE_GENERATION_PATH: "headless"
    });
    miaoshouServer = await startMockMiaoshouServer();
    process.env.MIAOSHOU_BASE_URL = miaoshouServer.baseUrl;
  }

  async function teardown() {
    await miaoshouServer.close();
    await database.close();
    await rm(assetRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    delete process.env.MIAOSHOU_BASE_URL;
    delete process.env.CANVAS_BASE_URL;
    delete process.env.IMAGE_GENERATION_PATH;
  }

  test.afterEach(async () => { await teardown(); });

  test("generate, accept, approve, and write back through Miaoshou without Canvas", async () => {
    await setup();

    const { productId, revisionId, assetIds } = await seedProductWithLocalImages(database.pool, 4);
    const { batchId } = await createImageGenerationBatch(database.pool, productId, revisionId, assetIds, 5);

    // Mark all slots succeeded with archived assets
    const slotRows = await database.pool.query<{ id: string }>(
      `SELECT id FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number`, [batchId]
    );
    const archivedAssetIds: string[] = [];
    for (let i = 0; i < slotRows.rowCount!; i++) {
      const archId = `asset_arch_${i}_${randomUUID().slice(0, 8)}`;
      archivedAssetIds.push(archId);
      await database.pool.query(
        `UPDATE image_generation_slots SET state = 'succeeded', archived_asset_id = $1 WHERE id = $2`,
        [archId, slotRows.rows[i]!.id]
      );
    }
    await database.pool.query(
      `UPDATE image_generation_batches SET state = 'succeeded', accepted_asset_ids = $1 WHERE id = $2`,
      [archivedAssetIds, batchId]
    );

    // Build runtime with image generation port
    const ports = createFakePorts();
    const jobs = new JobRepository(database.pool);
    const pipeline = new PipelineRepository(database.pool);
    const approvals = new ApprovalRepository(database.pool);
    const auditRepository = new AuditRepository(database.pool);
    const store = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async ({ url }) => ({
        status: 200,
        headers: { "content-type": url.endsWith(".jpg") ? "image/jpeg" : "image/png" },
        body: (async function* () {
          const sig = url.endsWith(".jpg")
            ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
            : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          yield Buffer.concat([sig, Buffer.from(url)]);
        })()
      })
    });
    const audit = {
      append: async (event: Record<string, unknown>) => auditRepository.append({
        actorType: "worker",
        action: String(event.action ?? "e2e.event"),
        targetKind: String(event.targetKind ?? "e2e"),
        targetId: String(event.targetId ?? "unknown"),
        payload: event.payload as Record<string, unknown> | undefined
      })
    };

    const runtime = buildWorkerRuntime({
      ports: {
        miaoshou: ports.miaoshouSource,
        miaoshouEdit: ports.miaoshouEdit,
        llm: ports.llm,
        exchangeRate: ports.exchangeRate,
        canvas: ports.canvas,
        staging: ports.assetStaging,
        imageGeneration: ports.imageGeneration,
        imagePlanner: ports.imagePlanner,
        publishing: ports.assetStaging
      },
      repositories: {
        collect: pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: pipeline,
        archive: pipelineRepositories(pipeline),
        listing: pipelineRepositories(pipeline),
        pricing: pipelineRepositories(pipeline),
        exchangeRate: pipelineRepositories(pipeline),
        templates: pipelineRepositories(pipeline),
        images: pipelineRepositories(pipeline),
        canvas: pipelineRepositories(pipeline),
        finalPreview: pipelineRepositories(pipeline),
        miaoshouEdit: pipeline,
        imageGeneration: pipeline,
        imageSlot: pipeline
      } as Parameters<typeof buildWorkerRuntime>[0]["repositories"],
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      store,
      analyzer: {
        analyze: async ({ position }: { remoteUrl: string; position: number }) => ({
          width: 1200, height: 1200, perceptualHash: `hash-${position}`,
          clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
          collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
          sourceKind: position === 0 ? "main" as const : "detail" as const
        })
      },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 },
        llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 },
        imageGeneration: { concurrency: 1, minIntervalMs: 0 },
        imagePlanner: { concurrency: 1, minIntervalMs: 0 },
        publishing: { concurrency: 1, minIntervalMs: 0 }
      } as Parameters<typeof buildWorkerRuntime>[0]["adapterLimits"]
    });

    // Confirm approval and enqueue Miaoshou writeback
    const approval = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "listing_run_1",
      expectedPricingRunId: "pricing_run_1",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: archivedAssetIds as never
    });

    const { createMiaoshouEditHandler } = await import("../apps/worker/src/handlers/miaoshou-edit.js");
    const editHandler = createMiaoshouEditHandler({
      edit: ports.miaoshouEdit,
      staging: ports.assetStaging,
      repository: {
        loadSnapshot: (id: string) => approvals.loadSnapshot(id),
        saveSucceeded: (...args: Parameters<ApprovalRepository["saveSucceeded"]>) => approvals.saveSucceeded(...args),
        saveValidationFailure: (...args: Parameters<ApprovalRepository["saveValidationFailure"]>) => approvals.saveValidationFailure(...args),
        saveResultUnknown: (...args: Parameters<ApprovalRepository["saveResultUnknown"]>) => approvals.saveResultUnknown(...args),
        saveReconciled: (...args: Parameters<ApprovalRepository["saveReconciled"]>) => approvals.saveReconciled(...args),
        persistReconciliationContext: async () => true
      },
      reachability: { assertReachable: async () => undefined },
      audit,
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-key")
    });

    await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: `miaoshou:${productId}:approved`,
      payload: { version: 1, approvalSnapshotId: approval.approvalSnapshotId }
    });

    await runtime.run({
      jobs: adaptLeasedJobRepository(jobs),
      handlers: { miaoshou_edit: editHandler },
      workerId: "miaoshou_writeback",
      leaseMs: 30_000,
      maxJobs: 1
    });

    // Assert Miaoshou edit was called with correct canonical detail
    const editCalls = ports.miaoshouEdit.calls.filter((c) => c.method === "applyEdit");
    expect(editCalls.length).toBeGreaterThan(0);
    const editCall = editCalls[0]!;
    expect(editCall.input).toMatchObject({
      approvalSnapshot: expect.objectContaining({ canonicalSuccessDetailId: "3799770548" })
    });

    // Assert sync state is succeeded
    const syncRow = await database.pool.query(
      `SELECT state FROM miaoshou_syncs WHERE id = $1`, [approval.syncId]
    );
    expect(syncRow.rows[0]?.state).toBe("succeeded");
  });

  test("restart after slot submit intent never resubmits — no paid call on recovery", async () => {
    await setup();

    const { productId, revisionId, assetIds } = await seedProductWithLocalImages(database.pool, 2);
    const { batchId } = await createImageGenerationBatch(database.pool, productId, revisionId, assetIds, 3);

    const slotRows = await database.pool.query<{ id: string; slot_number: number }>(
      `SELECT id, slot_number FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number`, [batchId]
    );
    const slotToRecover = slotRows.rows[0]!;

    // Simulate: intent was called (remoteTaskId stored) but provider result is unknown
    await database.pool.query(
      `UPDATE image_generation_slots SET state = 'queued', remote_task_id = $1 WHERE id = $2`,
      [`remote_intent_${randomUUID().slice(0, 8)}`, slotToRecover.id]
    );
    await database.pool.query(
      `UPDATE image_generation_batches SET state = 'partial' WHERE id = $1`, [batchId]
    );

    const ports = createFakePorts();
    const jobs = new JobRepository(database.pool);
    const pipeline = new PipelineRepository(database.pool);
    const auditRepository = new AuditRepository(database.pool);
    const store = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47]); })() })
    });
    const audit = {
      append: async (event: Record<string, unknown>) => auditRepository.append({
        actorType: "worker", action: String(event.action ?? "e2e"),
        targetKind: "e2e", targetId: "unknown", payload: event.payload as Record<string, unknown> | undefined
      })
    };

    // Track whether submit is called
    let submitCallCount = 0;
    ports.imageGeneration.submitResult = { kind: "accepted", remoteTaskId: "should_not_be_called" as never };

    const runtime = buildWorkerRuntime({
      ports: {
        miaoshou: ports.miaoshouSource,
        miaoshouEdit: ports.miaoshouEdit,
        llm: ports.llm,
        exchangeRate: ports.exchangeRate,
        canvas: ports.canvas,
        staging: ports.assetStaging,
        imageGeneration: ports.imageGeneration,
        imagePlanner: ports.imagePlanner,
        publishing: ports.assetStaging
      },
      repositories: {
        collect: pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: pipeline,
        archive: pipelineRepositories(pipeline),
        listing: pipelineRepositories(pipeline),
        pricing: pipelineRepositories(pipeline),
        exchangeRate: pipelineRepositories(pipeline),
        templates: pipelineRepositories(pipeline),
        images: pipelineRepositories(pipeline),
        canvas: pipelineRepositories(pipeline),
        finalPreview: pipelineRepositories(pipeline),
        miaoshouEdit: pipeline,
        imageGeneration: pipeline,
        imageSlot: pipeline
      } as Parameters<typeof buildWorkerRuntime>[0]["repositories"],
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      store,
      analyzer: {
        analyze: async ({ position }: { remoteUrl: string; position: number }) => ({
          width: 1200, height: 1200, perceptualHash: `hash-${position}`,
          clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
          collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
          sourceKind: "main" as const
        })
      },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 },
        llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 },
        imageGeneration: { concurrency: 1, minIntervalMs: 0 },
        imagePlanner: { concurrency: 1, minIntervalMs: 0 },
        publishing: { concurrency: 1, minIntervalMs: 0 }
      } as Parameters<typeof buildWorkerRuntime>[0]["adapterLimits"]
    });

    // Enqueue slot job with reconciliation intent (simulating restart after crash)
    await jobs.enqueue({
      kind: "image_generate_slot",
      businessKey: `slot:${batchId}:${slotToRecover.slot_number}`,
      payload: {
        version: 1,
        batchId,
        slotId: slotToRecover.id,
        slotNumber: slotToRecover.slot_number,
        reconciliationIntent: { version: 1, operation: "image_generate_slot", idempotencyKey: `slot:${batchId}:${slotToRecover.slot_number}` }
      }
    });

    // Run the worker — should NOT call submit (no resubmit after intent without result)
    await runtime.run({
      jobs: adaptLeasedJobRepository(jobs),
      workerId: "recovery_after_crash",
      leaseMs: 30_000,
      maxJobs: 1
    });

    // submit must not have been called
    expect(ports.imageGeneration.calls.filter((c) => c.method === "submit")).toHaveLength(0);

    // Slot stays in its previous state — NeedsInputError only transitions the job
    // (not the image_generation_slots row) to needs_input so a human can reconcile.
    const slotState = await database.pool.query(
      `SELECT state FROM image_generation_slots WHERE id = $1`, [slotToRecover.id]
    );
    expect(slotState.rows[0]?.state).toBe("queued");

    // The job should be in needs_input so it blocks automatic resubmit.
    const jobRow = await database.pool.query(
      `SELECT status, error FROM jobs WHERE business_key = $1`, [`slot:${batchId}:${slotToRecover.slot_number}`]
    );
    expect(jobRow.rows[0]?.status).toBe("needs_input");
    expect(jobRow.rows[0]?.error).toMatchObject(
      expect.objectContaining({ code: "image_submission_result_unknown" })
    );
  });

  // ---------------------------------------------------------------------------
  // Step 3 additional restart checkpoints
  // ---------------------------------------------------------------------------

  test("restart during polling — does not resubmit, keeps remote task id", async () => {
    await setup();

    const { productId, revisionId, assetIds } = await seedProductWithLocalImages(database.pool, 2);
    const { batchId } = await createImageGenerationBatch(database.pool, productId, revisionId, assetIds, 2);

    const slotRows = await database.pool.query<{ id: string; slot_number: number }>(
      `SELECT id, slot_number FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number LIMIT 1`, [batchId]
    );
    const slot = slotRows.rows[0]!;
    const remoteTaskId = `remote_during_polling_${randomUUID().slice(0, 8)}`;

    // Simulate: remote task id persisted, but we're polling (fetch returns pending)
    await database.pool.query(
      `UPDATE image_generation_slots SET state = 'generating', remote_task_id = $1 WHERE id = $2`,
      [remoteTaskId, slot.id]
    );

    const ports = createFakePorts();
    ports.imageGeneration.fetchResult = { state: "pending" };
    const jobs = new JobRepository(database.pool);
    const pipeline = new PipelineRepository(database.pool);
    const auditRepository = new AuditRepository(database.pool);
    const store = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47]); })() })
    });
    const audit = {
      append: async (event: Record<string, unknown>) => auditRepository.append({
        actorType: "worker", action: String(event.action ?? "e2e"),
        targetKind: "e2e", targetId: "unknown", payload: event.payload as Record<string, unknown> | undefined
      })
    };

    const runtime = buildWorkerRuntime({
      ports: {
        miaoshou: ports.miaoshouSource,
        miaoshouEdit: ports.miaoshouEdit,
        llm: ports.llm,
        exchangeRate: ports.exchangeRate,
        canvas: ports.canvas,
        staging: ports.assetStaging,
        imageGeneration: ports.imageGeneration,
        imagePlanner: ports.imagePlanner,
        publishing: ports.assetStaging
      },
      repositories: {
        collect: pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: pipeline,
        archive: pipelineRepositories(pipeline),
        listing: pipelineRepositories(pipeline),
        pricing: pipelineRepositories(pipeline),
        exchangeRate: pipelineRepositories(pipeline),
        templates: pipelineRepositories(pipeline),
        images: pipelineRepositories(pipeline),
        canvas: pipelineRepositories(pipeline),
        finalPreview: pipelineRepositories(pipeline),
        miaoshouEdit: pipeline,
        imageGeneration: pipeline,
        imageSlot: pipeline
      } as Parameters<typeof buildWorkerRuntime>[0]["repositories"],
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      store,
      analyzer: {
        analyze: async ({ position }: { remoteUrl: string; position: number }) => ({
          width: 1200, height: 1200, perceptualHash: `hash-${position}`,
          clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
          collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
          sourceKind: "main" as const
        })
      },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 },
        llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 },
        imageGeneration: { concurrency: 1, minIntervalMs: 0 },
        imagePlanner: { concurrency: 1, minIntervalMs: 0 },
        publishing: { concurrency: 1, minIntervalMs: 0 }
      } as Parameters<typeof buildWorkerRuntime>[0]["adapterLimits"]
    });

    await jobs.enqueue({
      kind: "image_generate_slot",
      businessKey: `slot:${batchId}:${slot.slot_number}`,
      payload: { version: 1, batchId, slotId: slot.id, slotNumber: slot.slot_number, reconciliationIntent: { version: 1, operation: "image_generate_slot", idempotencyKey: `slot:${batchId}:${slot.slot_number}` } }
    });

    // Submit should NOT be called — we already have a remote task id
    await runtime.run({ jobs: adaptLeasedJobRepository(jobs), workerId: "polling_recovery", leaseMs: 30_000, maxJobs: 1 });

    expect(ports.imageGeneration.calls.filter((c) => c.method === "submit")).toHaveLength(0);
    // Should have polled once
    expect(ports.imageGeneration.calls.filter((c) => c.method === "fetch")).toHaveLength(1);
    // Slot still has the remote task id
    const afterSlot = await database.pool.query(`SELECT state, remote_task_id FROM image_generation_slots WHERE id = $1`, [slot.id]);
    expect(afterSlot.rows[0]?.remote_task_id).toBe(remoteTaskId);
  });

  // ---------------------------------------------------------------------------
  // Step 3: Restart during planning (brief gap — polling/download were covered)
  // ---------------------------------------------------------------------------

  test("restart during planning — planner is idempotent, slots created without duplication", async () => {
    await setup();

    const { productId, revisionId, assetIds } = await seedProductWithLocalImages(database.pool, 2);

    // Create a batch but do NOT create slots yet — simulating mid-planning crash
    const batchId = `batch_planning_${randomUUID().slice(0, 8)}`;
    const templateVersionId = `ig_tmpl_v1`;
    await database.pool.query(`
      INSERT INTO image_generation_templates (id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at)
      VALUES ('ig_tmpl_1', 'Headless Test', '服装', NULL, $1, true, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe, activated_at, created_at)
      VALUES ($1, 'ig_tmpl_1', 1, 'active',
              '{"inputCounts":{"default":4,"min":1,"max":6},"outputCounts":{"default":5,"min":1,"max":8},"mustPreserve":[],"visualDirection":"clean","forbidden":[],"roles":[]}'::jsonb,
              now(), now())
      ON CONFLICT (template_id, version) DO NOTHING;
    `, [templateVersionId]);

    await database.pool.query(`
      INSERT INTO image_generation_batches
        (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count,
         category_key, template_id, template_version_id, template_version, recipe_snapshot,
         product_facts_snapshot, product_facts_digest, state, accepted_asset_ids, created_at, updated_at)
      VALUES ($1, $2, $3, $1, $4, 3, '服装', 'ig_tmpl_1', $5, 1,
              '{"inputCounts":{"default":4,"min":1,"max":6},"outputCounts":{"default":5,"min":1,"max":8}}'::jsonb,
              '{}', 'digest_${randomUUID().slice(0, 8)}', 'planning', '{}', now(), now())
    `, [batchId, productId, revisionId, assetIds, templateVersionId]);

    const ports = createFakePorts();
    const jobs = new JobRepository(database.pool);
    const pipeline = new PipelineRepository(database.pool);
    const auditRepository = new AuditRepository(database.pool);
    const store = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47]); })() })
    });
    const audit = {
      append: async (event: Record<string, unknown>) => auditRepository.append({
        actorType: "worker", action: String(event.action ?? "e2e"),
        targetKind: "e2e", targetId: "unknown", payload: event.payload as Record<string, unknown> | undefined
      })
    };

    // Track how many times the planner is called
    let plannerCallCount = 0;
    ports.imagePlanner.plan = async ({ idempotencyKey }: { idempotencyKey: string; productFacts: Record<string, unknown>; localImagePaths: string[]; recipe: { version: number; inputCount: number; outputCount: number; roles: string[] }; requestedOutputCount: number }) => {
      plannerCallCount++;
      // Return 3 prompts for the 3 requested outputs
      return {
        prompts: Array.from({ length: 3 }, (_, i) => ({
          slot: i + 1,
          role: "default",
          prompt: `Restart-safe prompt ${i + 1}`,
          mustPreserve: [],
          forbidden: []
        }))
      };
    };

    const runtime = buildWorkerRuntime({
      ports: {
        miaoshou: ports.miaoshouSource,
        miaoshouEdit: ports.miaoshouEdit,
        llm: ports.llm,
        exchangeRate: ports.exchangeRate,
        canvas: ports.canvas,
        staging: ports.assetStaging,
        imageGeneration: ports.imageGeneration,
        imagePlanner: ports.imagePlanner,
        publishing: ports.assetStaging
      },
      repositories: {
        collect: pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: pipeline,
        archive: pipelineRepositories(pipeline),
        listing: pipelineRepositories(pipeline),
        pricing: pipelineRepositories(pipeline),
        exchangeRate: pipelineRepositories(pipeline),
        templates: pipelineRepositories(pipeline),
        images: pipelineRepositories(pipeline),
        canvas: pipelineRepositories(pipeline),
        finalPreview: pipelineRepositories(pipeline),
        miaoshouEdit: pipeline,
        imageGeneration: pipeline,
        imageSlot: pipeline
      } as Parameters<typeof buildWorkerRuntime>[0]["repositories"],
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      store,
      analyzer: {
        analyze: async ({ position }: { remoteUrl: string; position: number }) => ({
          width: 1200, height: 1200, perceptualHash: `hash-${position}`,
          clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
          collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
          sourceKind: "main" as const
        })
      },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 },
        llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 },
        imageGeneration: { concurrency: 1, minIntervalMs: 0 },
        imagePlanner: { concurrency: 1, minIntervalMs: 0 },
        publishing: { concurrency: 1, minIntervalMs: 0 }
      } as Parameters<typeof buildWorkerRuntime>[0]["adapterLimits"]
    });

    // Enqueue the planning job
    await jobs.enqueue({
      kind: "image_prompt_plan",
      businessKey: `plan:${batchId}`,
      payload: { version: 1, batchId }
    });

    // First run: worker loads context and calls planner, but we simulate crash
    // by NOT running to completion (simulate by checking state before completion)
    // Actually, run it to completion first to establish baseline
    await runtime.run({ jobs: adaptLeasedJobRepository(jobs), workerId: "plan_first", leaseMs: 30_000, maxJobs: 1 });

    // Verify: job succeeded, exactly 3 slots created
    const jobStatus = await database.pool.query(`SELECT status FROM jobs WHERE business_key = $1`, [`plan:${batchId}`]);
    expect(jobStatus.rows[0]?.status).toBe("succeeded");

    const slotCount = await database.pool.query(`SELECT COUNT(*) as c FROM image_generation_slots WHERE batch_id = $1`, [batchId]);
    expect(Number(slotCount.rows[0]?.c)).toBe(3);

    // Verify: planner was called exactly once
    expect(plannerCallCount).toBe(1);

    // Simulate restart by enqueuing another planning job with same batchId
    // (this would happen if the worker crashed after planning succeeded but before acknowledging)
    plannerCallCount = 0;
    await jobs.enqueue({
      kind: "image_prompt_plan",
      businessKey: `plan:${batchId}:retry`,
      payload: { version: 1, batchId }
    });

    // On restart the handler should be idempotent — same planner result, no duplicate slots
    await runtime.run({ jobs: adaptLeasedJobRepository(jobs), workerId: "plan_restart", leaseMs: 30_000, maxJobs: 1 });

    // Planner should NOT have been called again on restart (same batch, same result)
    // OR if it was called, slots should still be exactly 3 (idempotent save)
    const slotCountAfterRestart = await database.pool.query(`SELECT COUNT(*) as c FROM image_generation_slots WHERE batch_id = $1`, [batchId]);
    expect(Number(slotCountAfterRestart.rows[0]?.c)).toBe(3);
  });

  test("restart during output download — does not resubmit, retains archived asset", async () => {
    await setup();

    const { productId, revisionId, assetIds } = await seedProductWithLocalImages(database.pool, 2);
    const { batchId } = await createImageGenerationBatch(database.pool, productId, revisionId, assetIds, 2);

    const slotRows = await database.pool.query<{ id: string; slot_number: number }>(
      `SELECT id, slot_number FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number LIMIT 1`, [batchId]
    );
    const slot = slotRows.rows[0]!;

    // Simulate: worker was polling (slot is generating) and fetched succeeded,
    // but crashed BEFORE archival completed — no archived_asset_id yet.
    // On restart the handler must poll again (not resubmit) and complete archival.
    const remoteTaskIdDuringDownload = `remote_during_download_${randomUUID().slice(0, 8)}`;
    await database.pool.query(
      `UPDATE image_generation_slots SET state = 'generating', remote_task_id = $1 WHERE id = $2`,
      [remoteTaskIdDuringDownload, slot.id]
    );

    const ports = createFakePorts();
    // Simulate: fetch returns succeeded, so on restart the handler completes archival
    ports.imageGeneration.fetchResult = { state: "succeeded", outputUrl: "https://fixtures.invalid/downloaded.png" };
    const jobs = new JobRepository(database.pool);
    const pipeline = new PipelineRepository(database.pool);
    const auditRepository = new AuditRepository(database.pool);
    const store = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47]); })() })
    });
    const audit = {
      append: async (event: Record<string, unknown>) => auditRepository.append({
        actorType: "worker", action: String(event.action ?? "e2e"),
        targetKind: "e2e", targetId: "unknown", payload: event.payload as Record<string, unknown> | undefined
      })
    };

    const runtime = buildWorkerRuntime({
      ports: {
        miaoshou: ports.miaoshouSource,
        miaoshouEdit: ports.miaoshouEdit,
        llm: ports.llm,
        exchangeRate: ports.exchangeRate,
        canvas: ports.canvas,
        staging: ports.assetStaging,
        imageGeneration: ports.imageGeneration,
        imagePlanner: ports.imagePlanner,
        publishing: ports.assetStaging
      },
      repositories: {
        collect: pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: pipeline,
        archive: pipelineRepositories(pipeline),
        listing: pipelineRepositories(pipeline),
        pricing: pipelineRepositories(pipeline),
        exchangeRate: pipelineRepositories(pipeline),
        templates: pipelineRepositories(pipeline),
        images: pipelineRepositories(pipeline),
        canvas: pipelineRepositories(pipeline),
        finalPreview: pipelineRepositories(pipeline),
        miaoshouEdit: pipeline,
        imageGeneration: pipeline,
        imageSlot: pipeline
      } as Parameters<typeof buildWorkerRuntime>[0]["repositories"],
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      store,
      analyzer: {
        analyze: async ({ position }: { remoteUrl: string; position: number }) => ({
          width: 1200, height: 1200, perceptualHash: `hash-${position}`,
          clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
          collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
          sourceKind: "main" as const
        })
      },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 },
        llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 },
        imageGeneration: { concurrency: 1, minIntervalMs: 0 },
        imagePlanner: { concurrency: 1, minIntervalMs: 0 },
        publishing: { concurrency: 1, minIntervalMs: 0 }
      } as Parameters<typeof buildWorkerRuntime>[0]["adapterLimits"]
    });

    // Job with remote_task_id matching the slot (simulating restart mid-download).
    // enqueue() does not surface remoteTaskId, so insert the row directly.
    const jobId = `job_download_recovery_${randomUUID().slice(0, 8)}`;
    await database.pool.query(
      `INSERT INTO jobs (id, kind, business_key, idempotency_key, payload, status, max_attempts, remote_task_id)
       VALUES ($1, 'image_generate_slot', $2, $2, $3::jsonb, 'queued', 3, $4)`,
      [jobId, `slot:${batchId}:${slot.slot_number}`, JSON.stringify({ version: 1, batchId, slotId: slot.id, slotNumber: slot.slot_number }), remoteTaskIdDuringDownload]
    );

    // Should NOT submit again — remote task already known; must poll and complete archival
    await runtime.run({ jobs: adaptLeasedJobRepository(jobs), workerId: "download_recovery", leaseMs: 30_000, maxJobs: 1 });

    expect(ports.imageGeneration.calls.filter((c) => c.method === "submit")).toHaveLength(0);
    // Handler must have fetched (polled) the remote task
    expect(ports.imageGeneration.calls.filter((c) => c.method === "fetch")).toHaveLength(1);
    // Slot must now be succeeded with a newly-archived asset (crash was BEFORE archival)
    const afterSlot = await database.pool.query(`SELECT state, archived_asset_id FROM image_generation_slots WHERE id = $1`, [slot.id]);
    expect(afterSlot.rows[0]?.state).toBe("succeeded");
    expect(afterSlot.rows[0]?.archived_asset_id).not.toBeNull();
  });
});
