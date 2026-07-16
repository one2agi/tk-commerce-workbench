import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { createFakePorts } from "../packages/contracts/src/testing/fake-ports.js";
import { ApprovalRepository } from "../packages/db/src/repositories/approval-repository.js";
import { AuditRepository } from "../packages/db/src/repositories/audit-repository.js";
import { CanvasQuotaRepository } from "../packages/db/src/repositories/canvas-quota-repository.js";
import { ContentAddressedStore } from "../packages/db/src/assets/content-addressed-store.js";
import { ExchangeRateRepository } from "../packages/db/src/repositories/exchange-rate-repository.js";
import { INITIAL_SQL } from "../packages/db/src/migrations/0000_initial.js";
import { JobRepository } from "../packages/db/src/repositories/job-repository.js";
import { PipelineRepository, pipelineRepositories } from "../packages/db/src/repositories/pipeline-repository.js";
import { createPostHandler as createIngestHandler } from "../apps/web/src/app/api/v1/ingest-links/route.js";
import { createPostHandler as createAutomationHandler } from "../apps/web/src/app/api/v1/automation-runs/route.js";
import { createPatchHandler as createDraftHandler } from "../apps/web/src/app/api/v1/products/[productId]/draft/route.js";
import { createExtensionTokenVerifier } from "../apps/web/src/server/auth/extension-token.js";
import { createServerServices } from "../apps/web/src/server/composition.js";
import { buildWorkerRuntime } from "../apps/worker/src/main.js";
import { createMiaoshouEditHandler } from "../apps/worker/src/handlers/miaoshou-edit.js";
import { adaptLeasedJobRepository, runWorkerLoop } from "../apps/worker/src/runtime/worker-loop.js";
import { createStagingCleanupCodec } from "../apps/worker/src/runtime/staging-cleanup-codec.js";
import { openE2eDatabase } from "./fixtures/test-database.js";

const SELECTED_URL = "https://detail.1688.com/offer/892408514788.html";
const UNSELECTED_URL = "https://detail.1688.com/offer/892408514799.html";
const EXTENSION_TOKEN = "wave3-e2e-extension";

function browserMutation(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("勾选采集到当前版本审批每个修订只生成一次 TK，且只编辑一次 canonical 妙手详情", async () => {
  test.setTimeout(90_000);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const database = await openE2eDatabase(process.env.TEST_DATABASE_URL);
  const assetRoot = await mkdtemp(join(tmpdir(), "tk-wave3-flow-"));
  try {
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
      MAX_CANVAS_RUNS_PER_DAY: "10"
    });
    await new ExchangeRateRepository(database.pool).recordManualOverride({ base: "CNY", target: "THB", rate: "4.80", observedAt: "2026-07-16T00:00:00Z" });
    await database.pool.query(
      `INSERT INTO templates (id, template_key, name, target_locale, enabled, version, category_rules)
       VALUES ('template-tk-v7', 'template-tk', 'TK 工作流', 'th-TH', true, 7, '[{"categoryKey":"服装","priority":10}]'::jsonb)`
    );

    const ports = createFakePorts();
    ports.miaoshouSource.responses.push({
      fetchDetailId: "fetch-detail-3799770548",
      skippedDetailId: null,
      canonicalSuccessDetailId: "3799770548" as never,
      detail: {
        detailId: "3799770548" as never,
        sourceItemId: "892408514788" as never,
        sourceUrl: SELECTED_URL,
        title: "轻薄防晒男士夹克",
        itemNumber: "SKU-1688-01",
        description: "透气面料，适合东南亚日常穿着",
        category: "服装",
        sourcePriceWire: { amountMinor: "3580", currency: "CNY" },
        sourceStock: 125,
        weightKg: "0.45",
        dimensionsCm: { lengthCm: "30", widthCm: "24", heightCm: "4" },
        mainImages: [
          { url: "https://cdn.test/main.jpg", width: 1200, height: 1200 },
          { url: "https://cdn.test/angle.jpg", width: 1200, height: 1200 }
        ],
        detailImages: [],
        sourceAttributes: [{ name: "面料", value: "聚酯纤维" }],
        saleAttributes: [{ name: "颜色", value: "黑色" }],
        colors: ["黑色"],
        sizes: ["M"],
        skus: [{ skuId: "sku-black-m", attributes: { 颜色: "黑色", 尺码: "M" }, priceWire: { amountMinor: "3580", currency: "CNY" }, stock: 60, imageUrl: "https://cdn.test/main.jpg" }]
      }
    });
    ports.miaoshouEdit.responses.push({ kind: "succeeded", remoteDetailId: "3799770548" as never });

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
          const signature = url.endsWith(".jpg")
            ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
            : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          yield Buffer.concat([signature, Buffer.from(url)]);
        })()
      })
    });
    const audit = { append: async (event: Record<string, unknown>) => auditRepository.append({
      actorType: "worker",
      action: String(event.action ?? "e2e.event"),
      targetKind: String(event.targetKind ?? "e2e"),
      targetId: String(event.targetId ?? "unknown"),
      payload: event.payload as Record<string, unknown> | undefined
    }) };
    const runtime = () => buildWorkerRuntime({
      ports: { miaoshou: ports.miaoshouSource, llm: ports.llm, exchangeRate: ports.exchangeRate, canvas: ports.canvas, staging: ports.assetStaging },
      repositories: pipelineRepositories(pipeline),
      store,
      analyzer: { analyze: async ({ remoteUrl, position }: { remoteUrl: string; position: number }) => ({
        width: 1200, height: 1200, perceptualHash: `hash-${position}-${remoteUrl}`,
        clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
        collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
        sourceKind: position === 0 ? "main" as const : "detail" as const
      }) },
      quota: new CanvasQuotaRepository(database.pool),
      audit,
      now: () => new Date(),
      cleanupCodec: createStagingCleanupCodec("wave3-e2e-cleanup-secret"),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 }, llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 }, canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 }
      }
    });

    const services = createServerServices({
      pool: database.pool,
      config: { extensionToken: EXTENSION_TOKEN, externalAdapterMode: "mock", assetRoot, workerConcurrency: 1,
        maxCanvasRunsPerDay: 10, miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true }
    });
    const ingest = createIngestHandler({ verifyToken: createExtensionTokenVerifier(EXTENSION_TOKEN), service: services.ingest });
    const candidateLinks = [SELECTED_URL, UNSELECTED_URL];
    const response = await ingest(new Request("http://127.0.0.1/api/v1/ingest-links", {
      method: "POST",
      headers: { authorization: `Bearer ${EXTENSION_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, batchId: "extension-selected-only", items: candidateLinks
        .filter((url) => url === SELECTED_URL)
        .map((sourceUrl) => ({ sourceUrl, idempotencyKey: "selected-892408514788" })) })
    }));
    expect(response.status).toBe(202);
    expect((await response.json()).jobs).toHaveLength(1);

    await runtime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "collector", leaseMs: 30_000, maxJobs: 1 });
    const collected = await database.pool.query<{ product_id: string; revision_id: string }>(
      `SELECT product.id AS product_id, revision.id AS revision_id
       FROM products product JOIN product_revisions revision ON revision.product_id = product.id`
    );
    const first = collected.rows[0]!;
    expect(await services.products.list()).toMatchObject({ items: [{ productId: first.product_id, automation: "not_started" }] });
    expect(ports.counters()).toMatchObject({ llm: 0, exchangeRate: 0, canvas: 0, assetStaging: 0 });

    const start = await createAutomationHandler({ service: services.automation })(browserMutation(
      "http://127.0.0.1/api/v1/automation-runs", { version: 1, revisionIds: [first.revision_id] }
    ));
    expect(start.status).toBe(202);
    await runtime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "automation-v1", leaseMs: 30_000, maxJobs: 10 });

    const readyV1 = await database.pool.query<{ working_draft: Record<string, unknown> }>(
      "SELECT working_draft FROM product_revisions WHERE id = $1", [first.revision_id]
    );
    const draftV1 = readyV1.rows[0]!.working_draft;
    const matchV1 = draftV1.templateMatch as { templateVersion?: number } | undefined;
    const finalOrderV1 = draftV1.finalAssetOrder as string[] | undefined;
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(1);
    expect(await database.pool.query("SELECT id FROM assets WHERE revision_id = $1 AND kind = 'generated'", [first.revision_id])).toMatchObject({ rowCount: 5 });
    expect(matchV1?.templateVersion).toBe(7);
    expect(finalOrderV1).toHaveLength(5);
    expect((await database.pool.query("SELECT state_automation FROM products WHERE id = $1", [first.product_id])).rows[0]?.state_automation).toBe("ready");

    const approvalV1 = await approvals.confirmAndEnqueue({
      version: 1, productId: first.product_id, expectedDraftVersion: 1,
      expectedListingRunId: String(draftV1.listingRunId), expectedPricingRunId: String(draftV1.pricingRunId),
      expectedTemplateVersion: 7, orderedFinalAssetIds: finalOrderV1 as never
    });

    const updateDraft = createDraftHandler({ drafts: {
      async update(command) {
        const client = await database.pool.connect();
        try {
          await client.query("BEGIN");
          const latest = await client.query<{
            id: string; draft_version: number; source_title: string | null;
            source_payload: Record<string, unknown>; working_draft: Record<string, unknown>;
          }>(`SELECT id, draft_version, source_title, source_payload, working_draft
              FROM product_revisions WHERE product_id = $1 ORDER BY draft_version DESC LIMIT 1 FOR UPDATE`,
          [command.productId]);
          const row = latest.rows[0];
          if (!row || row.draft_version !== command.expectedDraftVersion) throw new Error("draft_version_conflict");
          await approvals.invalidateForProductInTransaction(client, command.productId, "e2e_draft_edited");
          const revisionId = `revision_${randomUUID()}`;
          const nextDraft: Record<string, unknown> = {
            ...row.working_draft,
            ...(command.targetLocale ? { targetLocale: command.targetLocale } : {}),
            ...(command.translationStyle ? { style: command.translationStyle } : {}),
            approvalInvalidatedAt: new Date().toISOString(), warningCodes: [], finalAssetOrder: []
          };
          delete nextDraft.templateMatch;
          delete nextDraft.imageSelection;
          delete nextDraft.approvalPreview;
          await client.query(
            `INSERT INTO product_revisions (id, product_id, draft_version, source_title, source_payload, working_draft)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [revisionId, command.productId, row.draft_version + 1, row.source_title,
              JSON.stringify(row.source_payload), JSON.stringify(nextDraft)]
          );
          await client.query(
            `INSERT INTO assets
             (id, product_id, revision_id, remote_url, kind, state, width, height, sha256, local_path,
              extension, perceptual_hash, clarity, duplicate_distance, watermark_probability,
              collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason)
             SELECT 'asset_' || md5(id || $2), product_id, $2, remote_url, kind, state, width, height, sha256,
                    local_path, extension, perceptual_hash, clarity, duplicate_distance, watermark_probability,
                    collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason
             FROM assets WHERE revision_id = $1 AND kind <> 'generated'`,
            [row.id, revisionId]
          );
          await client.query(
            `UPDATE products SET locale = COALESCE($2, locale), state_listing = 'pending',
              state_canvas = 'not_started', state_approval = 'unapproved', state_miaoshou_edit = 'not_started',
              version = version + 1, updated_at = now() WHERE id = $1`,
            [command.productId, command.targetLocale ?? null]
          );
          await client.query("COMMIT");
          return { draftVersion: row.draft_version + 1, revisionId, approvalInvalidated: true as const };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    } });
    const editedResponse = await updateDraft(browserMutation(
      `http://127.0.0.1/api/v1/products/${first.product_id}/draft`,
      { version: 1, expectedDraftVersion: 1, targetLocale: "th-TH", translationStyle: "marketplace" }
    ), { params: Promise.resolve({ productId: first.product_id }) });
    expect(editedResponse.status).toBe(200);
    const edited = await editedResponse.json() as { revisionId: string; draftVersion: number };
    expect(edited.draftVersion).toBe(2);
    expect((await database.pool.query("SELECT state FROM approval_snapshots WHERE id = $1", [approvalV1.approvalSnapshotId])).rows[0]?.state).toBe("invalidated");

    await jobs.enqueue({ kind: "listing_generate", businessKey: `${edited.revisionId}:edited-listing`, batchKey: "edited-v2",
      payload: { version: 1, revisionId: edited.revisionId } });
    await runtime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "automation-v2", leaseMs: 30_000, maxJobs: 9 });
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(2);
    expect((await database.pool.query<{ outputs: string[] }>(
      "SELECT outputs FROM canvas_runs ORDER BY created_at"
    )).rows.every((run) => run.outputs.length === 5)).toBe(true);
    const readyV2 = await database.pool.query<{ working_draft: Record<string, unknown> }>(
      "SELECT working_draft FROM product_revisions WHERE id = $1", [edited.revisionId]
    );
    const draftV2 = readyV2.rows[0]!.working_draft;
    const finalOrderV2 = draftV2.finalAssetOrder as string[] | undefined;
    const currentApproval = await approvals.confirmAndEnqueue({
      version: 1, productId: first.product_id, expectedDraftVersion: 2,
      expectedListingRunId: String(draftV2.listingRunId), expectedPricingRunId: String(draftV2.pricingRunId),
      expectedTemplateVersion: 7, orderedFinalAssetIds: finalOrderV2 as never
    });
    expect(currentApproval.approvalSnapshotId).not.toBe(approvalV1.approvalSnapshotId);

    const editRepository = {
      loadSnapshot: (id: string) => approvals.loadSnapshot(id),
      saveSucceeded: (...args: Parameters<ApprovalRepository["saveSucceeded"]>) => approvals.saveSucceeded(...args),
      saveValidationFailure: (...args: Parameters<ApprovalRepository["saveValidationFailure"]>) => approvals.saveValidationFailure(...args),
      saveResultUnknown: (...args: Parameters<ApprovalRepository["saveResultUnknown"]>) => approvals.saveResultUnknown(...args),
      saveReconciled: (...args: Parameters<ApprovalRepository["saveReconciled"]>) => approvals.saveReconciled(...args),
      persistReconciliationContext: async () => true
    };
    const cleanupCodec = createStagingCleanupCodec({
      key: "wave3-e2e-staging-cleanup-key"
    });
    const editHandler = createMiaoshouEditHandler({ edit: ports.miaoshouEdit, staging: ports.assetStaging,
      repository: editRepository, reachability: { assertReachable: async () => undefined }, audit, cleanupCodec });
    await runWorkerLoop({ jobs: adaptLeasedJobRepository(jobs), handlers: { miaoshou_edit: editHandler }, clock: { now: () => new Date() },
      workerId: "miaoshou-current-approval", leaseMs: 30_000, maxJobs: 1 });

    const editCalls = ports.miaoshouEdit.calls.filter((call) => call.method === "applyEdit");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.input).toMatchObject({ approvalSnapshot: { canonicalSuccessDetailId: "3799770548", draftVersion: 2 } });
    expect(await database.pool.query("SELECT state FROM miaoshou_syncs WHERE id = $1", [currentApproval.syncId])).toMatchObject({ rows: [{ state: "succeeded" }] });
    const jobKinds = (await database.pool.query<{ kind: string }>("SELECT kind FROM jobs")).rows.map((row) => row.kind);
    expect(jobKinds).not.toContain("tiktok_publish");
    expect(jobKinds).not.toContain("tiktok_claim");
  } finally {
    await database.close();
    await rm(assetRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
  }
});
