import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakePorts } from "@tk/contracts/testing";
import {
  AuditRepository,
  CanvasQuotaRepository,
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

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
});

afterAll(async () => handle?.close());

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
    ports.miaoshouSource.responses.push({
      fetchDetailId: "fetch-1",
      skippedDetailId: null,
      canonicalSuccessDetailId: "detail-1",
      detail: {
        detailId: "detail-1", sourceItemId: "source-1" as never, sourceUrl: "https://detail.1688.com/offer/1.html",
        title: "男士短裤", itemNumber: null, description: "轻薄舒适", category: "服装",
        sourcePriceWire: { amountMinor: "1000", currency: "CNY" }, sourceStock: 5, weightKg: "0.3", dimensionsCm: null,
        mainImages: [{ url: "https://cdn.test/a.jpg", width: 1000, height: 1000 }], detailImages: [],
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
      store: { archive: vi.fn(async (remoteUrl: string) => ({ remoteUrl, finalUrl: remoteUrl, sha256: "hash-a", path: "/data/assets/ha/hash-a.jpg", extension: "jpg", bytes: 4 })) },
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
      payload: { version: 1, revisionId: revision.rows[0]!.id, remoteUrls: ["https://cdn.test/a.jpg"] }
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

    await handle.pool.query("UPDATE jobs SET status = 'succeeded' WHERE kind = 'staging_cleanup'");
    const recoveryJobId = await jobs.enqueue({ kind: "canvas_generate", businessKey: `${revision.rows[0]!.id}:canvas-recovery`, batchKey: "batch-1", payload: { version: 1, revisionId: revision.rows[0]!.id } });
    const claimedAt = new Date();
    const oldClaim = await jobs.claim("runtime-that-crashed", claimedAt, 25);
    expect(oldClaim?.jobId).toBe(recoveryJobId);
    expect(await jobs.persistRemoteTask(recoveryJobId, "runtime-that-crashed", oldClaim!.leaseToken, claimedAt, "persisted-remote-after-submit")).toBe(true);
    await jobs.releaseExpired(new Date(claimedAt.getTime() + 50));
    const submitsBeforeRecovery = ports.canvas.calls.filter((call) => call.method === "submit").length;
    const fetchesBeforeRecovery = ports.canvas.calls.filter((call) => call.method === "fetchOutputs").length;
    await makeRuntime().run({ jobs: adaptLeasedJobRepository(jobs), workerId: "brand-new-runtime", leaseMs: 30_000, maxJobs: 1, clock: { now: () => new Date(claimedAt.getTime() + 50) } });
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(submitsBeforeRecovery);
    expect(ports.canvas.calls.filter((call) => call.method === "fetchOutputs")).toHaveLength(fetchesBeforeRecovery + 1);
  });
});
