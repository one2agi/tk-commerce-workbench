import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePorts } from "@tk/contracts/testing";
import { createMiaoshouEditAdapter, fingerprintApprovalSnapshot, stableDigest, type MiaoshouHttp } from "@tk/adapters";
import {
  AuditRepository,
  ApprovalRepository,
  CanvasQuotaRepository,
  ContentAddressedStore,
  ExchangeRateRepository,
  INITIAL_SQL,
  JobRepository,
  PipelineRepository,
  bootTestDb,
  pipelineRepositories,
  type TestDbHandle
} from "@tk/db";
import { buildWorkerRuntime } from "./main.js";
import { createCollectHandler } from "./handlers/collect.js";
import { createMiaoshouEditHandler } from "./handlers/miaoshou-edit.js";
import { adaptLeasedJobRepository, runWorkerLoop } from "./runtime/worker-loop.js";

let handle: TestDbHandle;
const assetRoots: string[] = [];

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await Promise.all(assetRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real PostgreSQL worker composition", () => {
  it("persists selected collection then resumes a new runtime through every ready-preview DAG node", async () => {
    const pipeline = new PipelineRepository(handle.pool);
    const jobs = new JobRepository(handle.pool);
    const rates = new ExchangeRateRepository(handle.pool);
    const auditRepository = new AuditRepository(handle.pool);
    const quota = new CanvasQuotaRepository(handle.pool);
    await rates.recordManualOverride({ base: "CNY", target: "THB", rate: "4.80", observedAt: "2026-07-16T00:00:00Z" });
    await handle.pool.query(
      `INSERT INTO templates
        (id, template_key, name, target_locale, visual_style, prompt_fragment,
         reference_asset_ids, enabled, category_rules, version)
       VALUES
        ('template-default-v1', 'template-default', 'Default v1', 'th-TH', 'clean', '', '[]', true, '[]', 1),
        ('template-default-v2', 'template-default', 'Default v2', 'vi-VN', 'premium', 'summer light',
         '["template-reference"]', true, '[{"categoryKey":"服装","priority":10}]', 2)`
    );

    const ports = createFakePorts();
    let rejectedCanvasOutput: string | null = null;
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-canvas-assets-"));
    assetRoots.push(assetRoot);
    const localStore = new ContentAddressedStore({
      assetRoot,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async ({ url }) => {
        if (rejectedCanvasOutput && url.endsWith(rejectedCanvasOutput)) {
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body: (async function* () { yield Buffer.from("invalid png"); })()
          };
        }
        const signature = url.endsWith(".jpg")
          ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
          : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return {
          status: 200,
          headers: { "content-type": url.endsWith(".jpg") ? "image/jpeg" : "image/png" },
          body: (async function* () { yield Buffer.concat([signature, Buffer.from(url)]); })()
        };
      }
    });
    ports.miaoshouSource.responses.push({
      fetchDetailId: "fetch-1",
      skippedDetailId: null,
      canonicalSuccessDetailId: "detail-1",
      detail: {
        detailId: "detail-1", sourceItemId: "source-1" as never, sourceUrl: "https://detail.1688.com/offer/1.html",
        title: "男士短裤", itemNumber: null, description: "轻薄舒适", category: "服装",
        sourcePriceWire: { amountMinor: "1000", currency: "CNY" }, sourceStock: 5, weightKg: "0.3", dimensionsCm: null,
        mainImages: [
          { url: "https://cdn.test/a.jpg", width: 1200, height: 1200 },
          { url: "https://cdn.test/duplicate.jpg", width: 1200, height: 1200 }
        ],
        detailImages: [{ url: "https://cdn.test/rejected.jpg", width: 320, height: 320 }],
        sourceAttributes: [{ name: "颜色", value: "黑色" }], saleAttributes: [], colors: ["黑色"], sizes: [], skus: []
      }
    });
    const audit = { append: async (event: Record<string, unknown>) => auditRepository.append({
      actorType: "worker",
      action: String(event.action),
      targetKind: String(event.targetKind),
      targetId: String(event.targetId),
      payload: event.payload as Record<string, unknown> | undefined
    }) };
    const makeRuntime = () => buildWorkerRuntime({
      ports: { miaoshou: ports.miaoshouSource, miaoshouEdit: ports.miaoshouEdit, llm: ports.llm, exchangeRate: ports.exchangeRate, canvas: ports.canvas, staging: ports.assetStaging },
      repositories: {
        ...pipelineRepositories(pipeline),
        prepareMiaoshouWriteback: {} as never,
        miaoshouEdit: {} as never
      },
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: { protect: () => "protected", unprotect: () => ({ remoteUrls: [], expiresAt: "2026-07-16T01:00:00Z" }) },
      store: localStore,
      analyzer: { analyze: vi.fn(async ({ remoteUrl }: { remoteUrl: string }) => ({
        width: remoteUrl.includes("rejected") ? 320 : 1200,
        height: remoteUrl.includes("rejected") ? 320 : 1200,
        perceptualHash: remoteUrl.includes("rejected") ? "rejected-hash" : "duplicate-hash",
        clarity: 0.9, duplicateDistance: 10, watermarkProbability: 0.01,
        collageProbability: 0.01, nonProductProbability: 0.01, visualScore: 0.9,
        sourceKind: remoteUrl.includes("rejected") ? "detail" as const : "main" as const
      })) },
      quota,
      audit,
      // Repository fences compare against database now(); use wall-clock time so this
      // integration remains valid after the original authoring date.
      now: () => new Date(),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 }, llm: { concurrency: 1, minIntervalMs: 0 }, exchangeRate: { concurrency: 1, minIntervalMs: 0 },
        canvas: { concurrency: 1, minIntervalMs: 0 }, staging: { concurrency: 1, minIntervalMs: 0 }
      }
    });
    await jobs.enqueue({
      kind: "miaoshou_collect",
      businessKey: "collect-1",
      batchKey: "batch-1",
      payload: { version: 1, batchId: "batch-1", sourceUrl: "https://detail.1688.com/offer/1.html", idempotencyKey: "collect-1" }
    });
    await makeRuntime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "runtime-before-restart", leaseMs: 30_000, maxJobs: 1 });
    const revision = await handle.pool.query<{ id: string; product_id: string; source_payload: Record<string, unknown> }>("SELECT id, product_id, source_payload FROM product_revisions LIMIT 1");
    expect(revision.rows[0]).toBeTruthy();
    await handle.pool.query(
      `INSERT INTO assets
        (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
       VALUES ('template-reference', $1, $2, 'local:template-reference', 'reference', 'ready',
               '/data/templates/reference.png', 'png')`,
      [revision.rows[0]!.product_id, revision.rows[0]!.id]
    );
    await jobs.enqueue({
      kind: "asset_archive",
      businessKey: `${revision.rows[0]!.id}:archive`,
      batchKey: "batch-1",
      payload: {
        version: 1,
        revisionId: revision.rows[0]!.id,
        remoteUrls: ["https://cdn.test/a.jpg", "https://cdn.test/duplicate.jpg", "https://cdn.test/rejected.jpg"]
      }
    });

    await makeRuntime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "runtime-after-restart", leaseMs: 30_000, workerConcurrency: 2, maxJobs: 10 });

    const product = await handle.pool.query("SELECT state_automation FROM products LIMIT 1");
    expect(product.rows[0]?.state_automation).toBe("ready");
    const dag = await handle.pool.query("SELECT kind, status, batch_key FROM jobs WHERE kind <> 'miaoshou_collect' ORDER BY created_at ASC");
    expect(dag.rows.filter((row) => row.kind !== "staging_cleanup").map((row) => row.kind)).toEqual([
      "asset_archive", "listing_generate", "template_match", "image_select", "canvas_generate", "final_preview"
    ]);
    expect(dag.rows.filter((row) => row.kind !== "staging_cleanup").every((row) => row.status === "succeeded" && row.batch_key === "batch-1")).toBe(true);
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(1);
    const canvasSubmission = ports.canvas.calls.find((call) => call.method === "submit")?.input as {
      imageUrls: string[]; referenceImageUrls: string[]; promptContext: Record<string, string>; idempotencyKey: string;
    };
    expect(canvasSubmission).toMatchObject({
      referenceImageUrls: [expect.stringContaining("reference.png")],
      promptContext: {
        sourceLocale: "zh-CN", targetLocale: "vi-VN",
        style: "premium\n--- template prompt ---\nsummer light"
      },
      idempotencyKey: `canvas:${revision.rows[0]!.id}:2`
    });
    expect(canvasSubmission.imageUrls).toHaveLength(1);
    const qualityAssets = await handle.pool.query("SELECT id, remote_url, state, rejection_reason, perceptual_hash FROM assets WHERE revision_id = $1 AND kind NOT IN ('generated', 'reference') ORDER BY remote_url", [revision.rows[0]!.id]);
    expect(qualityAssets.rows).toHaveLength(3);
    expect(qualityAssets.rows.find((asset) => asset.remote_url.includes("rejected"))).toMatchObject({ state: "rejected", rejection_reason: "low_resolution" });
    const selectedRevision = await handle.pool.query<{ working_draft: Record<string, unknown> }>("SELECT working_draft FROM product_revisions WHERE id = $1", [revision.rows[0]!.id]);
    expect(selectedRevision.rows[0]?.working_draft.templateMatch).toMatchObject({
      templateId: "template-default", templateVersion: 2, targetLocale: "vi-VN",
      visualStyle: "premium", promptFragment: "summer light"
    });
    const selectedIds = ((selectedRevision.rows[0]?.working_draft.imageSelection as { assetIds?: string[] } | undefined)?.assetIds ?? []);
    expect(selectedIds).toHaveLength(1);
    expect(selectedIds).not.toContain(qualityAssets.rows.find((asset) => asset.remote_url.includes("rejected"))?.id);
    const generated = await handle.pool.query<{ id: string; remote_url: string; local_path: string }>(
      "SELECT id, remote_url, local_path FROM assets WHERE revision_id = $1 AND kind = 'generated'",
      [revision.rows[0]!.id]
    );
    expect(generated.rows).toHaveLength(5);
    await Promise.all(generated.rows.map(async (asset) => expect((await stat(asset.local_path)).isFile()).toBe(true)));
    const initialCanvas = await handle.pool.query<{ outputs: string[]; template_version: number }>("SELECT outputs, template_version FROM canvas_runs WHERE revision_id = $1", [revision.rows[0]!.id]);
    expect(initialCanvas.rows[0]?.outputs).toHaveLength(5);
    expect(initialCanvas.rows[0]?.template_version).toBe(2);
    expect(selectedRevision.rows[0]?.working_draft.finalAssetOrder).toEqual(initialCanvas.rows[0]?.outputs);
    const generatedById = new Map(generated.rows.map((asset) => [asset.id, asset.remote_url]));
    expect(initialCanvas.rows[0]?.outputs.map((id) => generatedById.get(id))).toEqual(ports.canvas.outputsResult.outputs.map((output) => output.url));

    await handle.pool.query("UPDATE jobs SET status = 'succeeded' WHERE kind = 'staging_cleanup'");
    rejectedCanvasOutput = "/2.png";
    const recoveryRevisionId = "revision-fresh-after-crash";
    await handle.pool.query(
      `INSERT INTO product_revisions (id, product_id, draft_version, source_title, source_payload, working_draft)
       SELECT $1, product_id, draft_version + 1, source_title, source_payload, working_draft
       FROM product_revisions WHERE id = $2`,
      [recoveryRevisionId, revision.rows[0]!.id]
    );
    await handle.pool.query(
      "UPDATE products SET state_automation = 'not_started', state_canvas = 'not_started' WHERE id = (SELECT product_id FROM product_revisions WHERE id = $1)",
      [recoveryRevisionId]
    );
    const recoveryJobId = await jobs.enqueue({ kind: "canvas_generate", businessKey: `${recoveryRevisionId}:canvas-recovery`, batchKey: "batch-1", payload: { version: 1, revisionId: recoveryRevisionId } });
    const claimedAt = new Date();
    const oldClaim = await jobs.claim("runtime-that-crashed", claimedAt, 25);
    expect(oldClaim?.jobId).toBe(recoveryJobId);
    expect(await jobs.persistRemoteTask(recoveryJobId, "runtime-that-crashed", oldClaim!.leaseToken, claimedAt, "persisted-remote-after-submit")).toBe(true);
    await jobs.releaseExpired(new Date(claimedAt.getTime() + 50));
    const submitsBeforeRecovery = ports.canvas.calls.filter((call) => call.method === "submit").length;
    const fetchesBeforeRecovery = ports.canvas.calls.filter((call) => call.method === "fetchOutputs").length;
    await makeRuntime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "brand-new-runtime", leaseMs: 30_000, maxJobs: 2, clock: { now: () => new Date(claimedAt.getTime() + 50) } });
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(submitsBeforeRecovery);
    expect(ports.canvas.calls.filter((call) => call.method === "fetchOutputs")).toHaveLength(fetchesBeforeRecovery + 1);
    const recoveredPreview = await handle.pool.query("SELECT status FROM jobs WHERE kind = 'final_preview' AND payload->>'revisionId' = $1", [recoveryRevisionId]);
    expect(recoveredPreview.rows[0]?.status).toBe("succeeded");
    const recoveredProduct = await handle.pool.query("SELECT state_automation FROM products WHERE id = (SELECT product_id FROM product_revisions WHERE id = $1)", [recoveryRevisionId]);
    expect(recoveredProduct.rows[0]?.state_automation).toBe("ready");
    const recoveredCanvas = await handle.pool.query<{ state: string; outputs: string[] }>("SELECT state, outputs FROM canvas_runs WHERE revision_id = $1", [recoveryRevisionId]);
    expect(recoveredCanvas.rows[0]).toMatchObject({ state: "partial" });
    expect(recoveredCanvas.rows[0]?.outputs).toHaveLength(4);
    const recoveredAssets = await handle.pool.query<{ id: string; local_path: string }>("SELECT id, local_path FROM assets WHERE revision_id = $1 AND kind = 'generated'", [recoveryRevisionId]);
    expect(recoveredAssets.rows.map((asset) => asset.id).sort()).toEqual([...(recoveredCanvas.rows[0]?.outputs ?? [])].sort());
    await Promise.all(recoveredAssets.rows.map(async (asset) => expect((await stat(asset.local_path)).isFile()).toBe(true)));

    const paidJobId = await jobs.enqueue({
      kind: "listing_generate",
      businessKey: `${revision.rows[0]!.id}:listing-paid-crash`,
      batchKey: "batch-1",
      payload: { version: 1, revisionId: revision.rows[0]!.id }
    });
    const paidClaimedAt = new Date(claimedAt.getTime() + 100);
    expect((await jobs.claim("runtime-that-lost-paid-request", paidClaimedAt, 25))?.jobId).toBe(paidJobId);
    await jobs.releaseExpired(new Date(paidClaimedAt.getTime() + 50));
    const llmCallsBeforeRestart = ports.llm.calls.length;
    await makeRuntime().run({
      jobs: adaptLeasedJobRepository(jobs),
      workerId: "runtime-after-paid-request-crash",
      leaseMs: 30_000,
      maxJobs: 1,
      clock: { now: () => new Date(paidClaimedAt.getTime() + 50) }
    });
    expect(ports.llm.calls).toHaveLength(llmCallsBeforeRestart);
    const paidJob = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [paidJobId]);
    expect(paidJob.rows[0]).toMatchObject({ status: "needs_input", error: { code: "reconcile_required" } });
  });

  it("recovers a crash after Miaoshou acceptance through JobRepository marker and reconciliation only", async () => {
    const suffix = Date.now().toString(36);
    const operatorId = `operator-edit-${suffix}`;
    const productId = `product-edit-${suffix}`;
    const revisionId = `revision-edit-${suffix}`;
    const approvalSnapshotId = `approval-edit-${suffix}`;
    await handle.pool.query(
      `INSERT INTO local_operators (id, handle, display_name) VALUES ($1, $2, 'Edit Recovery')`,
      [operatorId, `edit-recovery-${suffix}`]
    );
    await handle.pool.query(
      `INSERT INTO products
       (id, operator_id, source_url, source_item_id, canonical_success_detail_id,
        state_automation, state_approval, state_miaoshou_edit)
       VALUES ($1, $2, $3, 'source-edit', 'canonical-edit', 'ready', 'approved', 'queued')`,
      [productId, operatorId, `https://detail.1688.com/offer/${suffix}.html`]
    );
    await handle.pool.query(
      `INSERT INTO product_revisions (id, product_id, draft_version, source_payload, working_draft)
       VALUES ($1, $2, 1, '{}'::jsonb, '{}'::jsonb)`,
      [revisionId, productId]
    );
    const assetRoot = await mkdtemp(join(tmpdir(), "tk-edit-recovery-assets-"));
    assetRoots.push(assetRoot);
    const finalAssetPath = join(assetRoot, "asset-edit.png");
    await writeFile(finalAssetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await handle.pool.query(
      `INSERT INTO assets
       (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
       VALUES ('asset-edit', $1, $2, 'https://canvas.test/asset-edit.png',
               'generated', 'ready', $3, 'png')`,
      [productId, revisionId, finalAssetPath]
    );
    await handle.pool.query(
      `INSERT INTO approval_snapshots
       (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
        template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
        source_item_id, canonical_success_detail_id, locale, currency, title, description,
        attributes, price_minor, price_currency, stock, weight_kg, skus, state)
       VALUES ($1, $2, $3, 1, 'listing-edit', 'pricing-edit', 1, '["asset-edit"]'::jsonb,
               '1688', $4, 'source-edit', 'canonical-edit', 'th-TH', 'THB', 'title',
               'description', '[]'::jsonb, '25900', 'THB', 1, '0.3', '[]'::jsonb, 'approved')`,
      [approvalSnapshotId, productId, revisionId, `https://detail.1688.com/offer/${suffix}.html`]
    );
    await handle.pool.query(
      `INSERT INTO miaoshou_syncs (id, approval_snapshot_id, state)
       VALUES ($1, $2, 'queued')`,
      [`sync-edit-${suffix}`, approvalSnapshotId]
    );

    const jobs = new JobRepository(handle.pool);
    const approvals = new ApprovalRepository(handle.pool);
    const jobId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: `miaoshou-edit:${approvalSnapshotId}`,
      payload: { version: 1, approvalSnapshotId, productId, canonicalSuccessDetailId: "canonical-edit" }
    });
    const ports = createFakePorts();
    let applyCount = 0;
    let remoteDetail: Record<string, unknown> = {
      commonCollectBoxDetailId: "canonical-edit",
      sourceList: [{ sourceItemId: "source-edit" }],
      title: "before"
    };
    const http: MiaoshouHttp = {
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path.includes("get_common_collect_box_detail")) {
          return { result: "success", data: { ossMd5: "md5", editCommonCollectBoxDetail: remoteDetail } } as never;
        }
        applyCount += 1;
        const sent = body.editCommonCollectBoxDetail as Record<string, unknown>;
        const sentSkus = sent.skuMap as Record<string, Record<string, unknown>>;
        // Match the verified GET fixture: top-level editable fields are echoed,
        // while every SKU echoes price/stock only.
        remoteDetail = {
          commonCollectBoxDetailId: "canonical-edit",
          sourceList: [{ sourceItemId: "source-edit" }],
          ...Object.fromEntries([
            "title", "itemNum", "notesText", "notes", "price", "stock", "weight",
            "packageLength", "packageWidth", "packageHeight", "imgUrls", "sourceAttrs"
          ].filter((key) => sent[key] !== undefined).map((key) => [key, sent[key]])),
          skuMap: Object.fromEntries(Object.entries(sentSkus ?? {}).map(([key, sku]) => [key, { price: sku.price, stock: sku.stock }]))
        };
        return { result: "success" } as never;
      })
    };
    let crashAfterRemoteAcceptance = true;
    const repository = {
      loadSnapshot: (id: string) => approvals.loadSnapshot(id),
      saveSucceeded: async (...args: Parameters<ApprovalRepository["saveSucceeded"]>) => {
        if (crashAfterRemoteAcceptance) {
          crashAfterRemoteAcceptance = false;
          throw new Error("simulated database crash after remote acceptance");
        }
        return approvals.saveSucceeded(...args);
      },
      saveValidationFailure: (...args: Parameters<ApprovalRepository["saveValidationFailure"]>) => approvals.saveValidationFailure(...args),
      saveResultUnknown: (...args: Parameters<ApprovalRepository["saveResultUnknown"]>) => approvals.saveResultUnknown(...args),
      saveReconciliationResultUnknown: (...args: Parameters<ApprovalRepository["saveReconciliationResultUnknown"]>) => approvals.saveReconciliationResultUnknown(...args),
      saveReconciled: (...args: Parameters<ApprovalRepository["saveReconciled"]>) => approvals.saveReconciled(...args),
      persistReconciliationContext: (context: Parameters<JobRepository["persistMiaoshouReconciliationContext"]>[4], fence: { jobId: string; owner: string; leaseToken: string }) =>
        jobs.persistMiaoshouReconciliationContext(fence.jobId, fence.owner, fence.leaseToken, new Date(), context)
    };
    const makeEdit = () => createMiaoshouEditAdapter({
      http,
      expectationResolver: {
        resolve: async ({ canonicalSuccessDetailId, sourceItemId }) =>
          await (async () => {
            const context = await jobs.loadMiaoshouReconciliationContext(canonicalSuccessDetailId, sourceItemId);
            if (!context) return undefined;
            const loaded = await approvals.loadSnapshot(context.approvalSnapshotId);
            if (stableDigest(loaded) !== context.approvalSnapshotDigest) return undefined;
            const expected = fingerprintApprovalSnapshot(loaded, context.orderedRemoteAssetUrlSha256);
            return stableDigest(expected) === stableDigest(context.expectedDetail) ? expected : undefined;
          })()
      }
    });
    const makeHandler = () => createMiaoshouEditHandler({
      edit: makeEdit(),
      staging: ports.assetStaging,
      repository,
      reachability: { assertReachable: async () => undefined },
      cleanupCodec: { protect: () => "protected", unprotect: () => ({ remoteUrls: [], expiresAt: "2026-07-16T01:00:00Z" }) },
      audit: { append: async () => undefined }
    });
    const leasedJobs = adaptLeasedJobRepository(jobs);

    await runWorkerLoop({
      jobs: leasedJobs,
      handlers: { miaoshou_edit: makeHandler() },
      clock: { now: () => new Date() },
      workerId: "edit-worker-before-crash",
      leaseMs: 30_000,
      maxJobs: 1
    });
    const unknown = await handle.pool.query("SELECT status, remote_task_id, error FROM jobs WHERE id = $1", [jobId]);
    expect(unknown.rows[0]).toMatchObject({
      status: "needs_input",
      remote_task_id: expect.stringMatching(/^canonical:canonical-edit:ctx:[a-f0-9]{64}$/),
      error: { code: "reconcile_required" }
    });

    await runWorkerLoop({
      jobs: leasedJobs,
      handlers: { miaoshou_edit: makeHandler() },
      clock: { now: () => new Date() },
      workerId: "edit-worker-after-restart",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(applyCount).toBe(1);
    expect((http.post as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => String(path).includes("get_common_collect_box_detail"))).toHaveLength(2);
    const recovered = await handle.pool.query(
      `SELECT job.status, sync.state
       FROM jobs job JOIN miaoshou_syncs sync ON sync.approval_snapshot_id = $2
       WHERE job.id = $1`,
      [jobId, approvalSnapshotId]
    );
    expect(recovered.rows[0]).toEqual({ status: "succeeded", state: "succeeded" });
  });

  it("persists ambiguous collection as reconciliation-only and never writes twice after restart", async () => {
    const suffix = Date.now().toString(36);
    const jobs = new JobRepository(handle.pool);
    const pipeline = new PipelineRepository(handle.pool);
    const auditRepository = new AuditRepository(handle.pool);
    const fetchItem = vi.fn(async () => {
      throw new Error("simulated timeout after Miaoshou may have accepted the collection");
    });
    const fakeMiaoshou = createFakePorts().miaoshouSource;
    const handler = createCollectHandler({
      port: {
        fetchItem,
        resolveCanonicalSuccessDetail: (input) => fakeMiaoshou.resolveCanonicalSuccessDetail(input)
      },
      repository: pipeline,
      audit: {
        append: async (event) => auditRepository.append({
          actorType: "worker",
          action: String(event.action),
          targetKind: String(event.targetKind),
          targetId: String(event.targetId),
          payload: event.payload as Record<string, unknown> | undefined
        })
      }
    });
    const jobId = await jobs.enqueue({
      kind: "miaoshou_collect",
      businessKey: `collect-ambiguous-${suffix}`,
      payload: {
        version: 1,
        batchId: `batch-ambiguous-${suffix}`,
        sourceUrl: `https://detail.1688.com/offer/${suffix}.html`,
        idempotencyKey: `collect-ambiguous-${suffix}`
      }
    });
    const leasedJobs = adaptLeasedJobRepository(jobs);

    await runWorkerLoop({
      jobs: leasedJobs,
      handlers: { miaoshou_collect: handler },
      clock: { now: () => new Date() },
      workerId: "collect-worker-before-restart",
      leaseMs: 30_000,
      maxJobs: 1
    });

    const persisted = await handle.pool.query("SELECT status, remote_task_id, error FROM jobs WHERE id = $1", [jobId]);
    expect(persisted.rows[0]).toEqual({
      status: "needs_input",
      remote_task_id: null,
      error: {
        kind: "reconcile_required",
        code: "reconcile_required",
        safeMessage: "External request result must be reconciled before retry"
      }
    });
    const resultAudit = await handle.pool.query(
      "SELECT payload FROM audit_events WHERE action = 'miaoshou.collect.result' AND target_id = $1 ORDER BY created_at DESC LIMIT 1",
      [`batch-ambiguous-${suffix}`]
    );
    expect(resultAudit.rows[0]?.payload).toEqual({ state: "result_unknown", code: "reconcile_required" });
    expect(await jobs.retrySafe(jobId, new Date())).toBe(false);

    await runWorkerLoop({
      jobs: leasedJobs,
      handlers: { miaoshou_collect: handler },
      clock: { now: () => new Date() },
      workerId: "collect-worker-after-restart",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(fetchItem).toHaveBeenCalledTimes(1);
  });
});
