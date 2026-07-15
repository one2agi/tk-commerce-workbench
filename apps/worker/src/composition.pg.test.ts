import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePorts } from "@tk/contracts/testing";
import {
  AuditRepository,
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
import { adaptLeasedJobRepository } from "./runtime/worker-loop.js";

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
      `INSERT INTO templates (id, name, target_locale, enabled, category_rules)
       VALUES ('template-default', 'Default', 'th-TH', true, '[]'::jsonb)`
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
      ports: { miaoshou: ports.miaoshouSource, llm: ports.llm, exchangeRate: ports.exchangeRate, canvas: ports.canvas, staging: ports.assetStaging },
      repositories: pipelineRepositories(pipeline),
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
      now: () => new Date("2026-07-16T00:00:00Z"),
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
    const revision = await handle.pool.query<{ id: string; source_payload: Record<string, unknown> }>("SELECT id, source_payload FROM product_revisions LIMIT 1");
    expect(revision.rows[0]).toBeTruthy();
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
      "asset_archive", "listing_generate", "pricing_calculate", "template_match", "image_select", "canvas_generate", "final_preview"
    ]);
    expect(dag.rows.filter((row) => row.kind !== "staging_cleanup").every((row) => row.status === "succeeded" && row.batch_key === "batch-1")).toBe(true);
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(1);
    const qualityAssets = await handle.pool.query("SELECT id, remote_url, state, rejection_reason, perceptual_hash FROM assets WHERE revision_id = $1 AND kind <> 'generated' ORDER BY remote_url", [revision.rows[0]!.id]);
    expect(qualityAssets.rows).toHaveLength(3);
    expect(qualityAssets.rows.find((asset) => asset.remote_url.includes("rejected"))).toMatchObject({ state: "rejected", rejection_reason: "low_resolution" });
    const selectedRevision = await handle.pool.query<{ working_draft: Record<string, unknown> }>("SELECT working_draft FROM product_revisions WHERE id = $1", [revision.rows[0]!.id]);
    const selectedIds = ((selectedRevision.rows[0]?.working_draft.imageSelection as { assetIds?: string[] } | undefined)?.assetIds ?? []);
    expect(selectedIds).toHaveLength(1);
    expect(selectedIds).not.toContain(qualityAssets.rows.find((asset) => asset.remote_url.includes("rejected"))?.id);
    const generated = await handle.pool.query<{ id: string; remote_url: string; local_path: string }>(
      "SELECT id, remote_url, local_path FROM assets WHERE revision_id = $1 AND kind = 'generated'",
      [revision.rows[0]!.id]
    );
    expect(generated.rows).toHaveLength(5);
    await Promise.all(generated.rows.map(async (asset) => expect((await stat(asset.local_path)).isFile()).toBe(true)));
    const initialCanvas = await handle.pool.query<{ outputs: string[] }>("SELECT outputs FROM canvas_runs WHERE revision_id = $1", [revision.rows[0]!.id]);
    expect(initialCanvas.rows[0]?.outputs).toHaveLength(5);
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
});
