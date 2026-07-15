// Integration test for repositories.
//
// Scenarios:
//  - migrate empty Postgres
//  - upsert fixed local operator
//  - insert one product with two revisions (revision #2 must NOT overwrite revision #1)
//  - claim a job, second claim with same owner+now+lease returns ONE job
//  - exchange_rate_snapshots records source/observedAt/manual override provenance

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { ConfirmMiaoshouEditV1 } from "@tk/contracts";

import { bootTestDb, type TestDbHandle } from "./runner.js";
import { CatalogRepository } from "../repositories/catalog-repository.js";
import { JobRepository } from "../repositories/job-repository.js";
import { ExchangeRateRepository } from "../repositories/exchange-rate-repository.js";
import { AutomationRunRepository } from "../repositories/automation-run-repository.js";
import { CanvasQuotaRepository } from "../repositories/canvas-quota-repository.js";
import { AssetRepository } from "../repositories/asset-repository.js";
import { PipelineRepository } from "../repositories/pipeline-repository.js";
import {
  ApprovalNotReadyError,
  ApprovalRepository
} from "../repositories/approval-repository.js";
import { INITIAL_SQL } from "../migrations/0000_initial.js";

let handle: TestDbHandle;
let catalog: CatalogRepository;
let jobs: JobRepository;
let rates: ExchangeRateRepository;
let automations: AutomationRunRepository;
let approvals: ApprovalRepository;
let canvasQuota: CanvasQuotaRepository;
let assets: AssetRepository;
let pipeline: PipelineRepository;

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.migrate(INITIAL_SQL);
  catalog = new CatalogRepository(handle.pool);
  jobs = new JobRepository(handle.pool);
  rates = new ExchangeRateRepository(handle.pool);
  automations = new AutomationRunRepository(handle.pool);
  approvals = new ApprovalRepository(handle.pool);
  canvasQuota = new CanvasQuotaRepository(handle.pool);
  assets = new AssetRepository(handle.pool);
  pipeline = new PipelineRepository(handle.pool);
});

beforeEach(async () => {
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
});

afterAll(async () => {
  await handle?.close();
});

describe("integration: bootstrap", () => {
  test("migration is idempotent — second run is a no-op", async () => {
    await handle.migrate(INITIAL_SQL);
    // Schema must still exist with the same tables.
    const result = await handle.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = result.rows.map((r) => r.table_name).sort();
    expect(names).toContain("products");
    expect(names).toContain("product_revisions");
    expect(names).toContain("jobs");
    expect(names).toContain("exchange_rate_snapshots");
    expect(names).toContain("automation_runs");
  });

  test("upgrades duplicate product identities and legacy detail_id without data loss or canonical guessing", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "legacy-operator",
      displayName: "Legacy Operator"
    });
    await handle.pool.query("DROP INDEX products_operator_source_item_unique");
    await handle.pool.query("ALTER TABLE miaoshou_source_records ADD COLUMN detail_id TEXT");
    await handle.pool.query(
      `INSERT INTO products
        (id, operator_id, source_url, source_item_id, canonical_success_detail_id)
       VALUES
        ('prod-legacy-a', $1, 'https://detail.1688.com/offer/legacy-a.html', 'legacy-1', NULL),
        ('prod-legacy-b', $1, 'https://detail.1688.com/offer/legacy-b.html', 'legacy-1', 'known-canonical')`,
      [operatorId]
    );
    await handle.pool.query(
      `INSERT INTO product_revisions (id, product_id, draft_version, source_payload, working_draft)
       VALUES
        ('rev-legacy-a', 'prod-legacy-a', 1, '{}'::jsonb, '{}'::jsonb),
        ('rev-legacy-b', 'prod-legacy-b', 1, '{}'::jsonb, '{}'::jsonb)`
    );
    await handle.pool.query(
      `INSERT INTO miaoshou_source_records
        (id, product_id, source_item_id, detail_id, fetch_detail_id,
         canonical_success_detail_id, fetched_payload)
       VALUES ('source-legacy', 'prod-legacy-a', 'legacy-1', 'legacy-detail', NULL, NULL, '{}'::jsonb)`
    );

    await handle.migrate(INITIAL_SQL);

    const products = await handle.pool.query(
      `SELECT id, source_url, source_item_id, canonical_success_detail_id
       FROM products WHERE id IN ('prod-legacy-a', 'prod-legacy-b') ORDER BY id`
    );
    expect(products.rows).toEqual([
      {
        id: "prod-legacy-a",
        source_url: "https://detail.1688.com/offer/legacy-a.html",
        source_item_id: null,
        canonical_success_detail_id: null
      },
      {
        id: "prod-legacy-b",
        source_url: "https://detail.1688.com/offer/legacy-b.html",
        source_item_id: "legacy-1",
        canonical_success_detail_id: "known-canonical"
      }
    ]);
    const revisions = await handle.pool.query(
      "SELECT id FROM product_revisions WHERE id IN ('rev-legacy-a', 'rev-legacy-b') ORDER BY id"
    );
    expect(revisions.rows.map((row) => row.id)).toEqual(["rev-legacy-a", "rev-legacy-b"]);
    const source = await handle.pool.query(
      `SELECT fetch_detail_id, canonical_success_detail_id, failure_reason
       FROM miaoshou_source_records WHERE id = 'source-legacy'`
    );
    expect(source.rows[0]).toEqual({
      fetch_detail_id: "legacy-detail",
      canonical_success_detail_id: null,
      failure_reason: "legacy_detail_id_requires_reparse"
    });
  });
});

describe("integration: catalog repository", () => {
  test("upserts the fixed local operator", async () => {
    const id = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    expect(id).toMatch(/^op_/);
    // Calling again returns the same id.
    const id2 = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    expect(id2).toBe(id);
  });

  test("inserts product with two revisions without overwriting", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/123.html",
      locale: "th-TH",
      currency: "THB"
    });

    const revA = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "v1 title",
      workingDraft: { foo: "bar" }
    });
    const revB = await catalog.insertRevision({
      productId,
      draftVersion: 2,
      sourceTitle: "v2 title",
      workingDraft: { foo: "baz" }
    });

    expect(revA).not.toBe(revB);
    const all = await catalog.listRevisions(productId);
    expect(all).toHaveLength(2);
    // Both revisions preserved (no overwrite).
    expect(all.map((r) => r.sourceTitle).sort()).toEqual(["v1 title", "v2 title"]);
  });

  test("reuses product identity for the same operator and source item", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const first = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/123.html",
      sourceItemId: "123",
      locale: "th-TH",
      currency: "THB"
    });
    const second = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/123.html?spm=repeat",
      sourceItemId: "123",
      locale: "th-TH",
      currency: "THB"
    });
    expect(second).toBe(first);
    const count = await handle.pool.query(
      "SELECT count(*)::int AS count FROM products WHERE operator_id = $1 AND source_item_id = '123'",
      [operatorId]
    );
    expect(count.rows[0].count).toBe(1);
  });
});

describe("integration: asset repository", () => {
  test("deduplicates a remote asset and persists archive plus quality evidence", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "asset-operator", displayName: "Asset Operator" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/asset.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "asset", workingDraft: {} });
    const input = { productId, revisionId, remoteUrl: "https://cdn.example.test/product.jpg", kind: "main" as const, width: 1200, height: 1200 };
    const first = await assets.upsert(input);
    const second = await assets.upsert(input);
    expect(second).toBe(first);

    await assets.recordProcessed({
      assetId: first,
      sha256: "abc123",
      localPath: "/data/assets/ab/abc123.jpg",
      extension: "jpg",
      perceptualHash: "phash-1",
      clarity: 0.91,
      duplicateDistance: 8,
      watermarkProbability: 0.03,
      collageProbability: 0.04,
      nonProductProbability: 0.02,
      visualScore: 0.88,
      chosenRole: "primary",
      rejectionReason: null
    });

    const stored = await handle.pool.query("SELECT * FROM assets WHERE product_id = $1 AND remote_url = $2", [productId, input.remoteUrl]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      state: "ready",
      sha256: "abc123",
      local_path: "/data/assets/ab/abc123.jpg",
      extension: "jpg",
      perceptual_hash: "phash-1",
      chosen_role: "primary",
      rejection_reason: null
    });
  });

  test("keeps the same remote URL independently attached to two immutable revisions", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "immutable-assets", displayName: "Immutable Assets" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/immutable.html", locale: "th-TH", currency: "THB" });
    const firstRevision = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "one", workingDraft: {} });
    const secondRevision = await catalog.insertRevision({ productId, draftVersion: 2, sourceTitle: "two", workingDraft: {} });
    const remoteUrl = "https://cdn.example.test/shared.jpg";
    const first = await assets.upsert({ productId, revisionId: firstRevision, remoteUrl, kind: "main" });
    const second = await assets.upsert({ productId, revisionId: secondRevision, remoteUrl, kind: "main" });
    expect(second).not.toBe(first);
    const rows = await handle.pool.query("SELECT revision_id FROM assets WHERE product_id = $1 AND remote_url = $2 ORDER BY revision_id", [productId, remoteUrl]);
    expect(rows.rows.map((row) => row.revision_id)).toEqual([firstRevision, secondRevision].sort());
  });
});

describe("integration: durable pipeline repository", () => {
  const collectedDetail = {
    detailId: "detail-canonical", sourceItemId: "source-canonical" as never, sourceUrl: "https://detail.1688.com/offer/canonical.html",
    title: "Canonical", itemNumber: null, description: "Description", category: null,
    sourcePriceWire: { amountMinor: "1000", currency: "CNY" as const }, sourceStock: 1, weightKg: "0.3", dimensionsCm: null,
    mainImages: [], detailImages: [], sourceAttributes: [], saleAttributes: [], colors: [], sizes: [], skus: []
  };

  test("reuses one canonical revision across first-success and duplicate-skip collection attempts", async () => {
    const firstJob = await jobs.enqueue({ kind: "miaoshou_collect", businessKey: "canonical:first", payload: { version: 1 } });
    const firstClaim = await jobs.claim("worker-first", new Date(), 30_000);
    const first = await pipeline.saveCollected({
      batchId: "batch-first", sourceUrl: collectedDetail.sourceUrl,
      result: { fetchDetailId: "fetch-first", skippedDetailId: null, canonicalSuccessDetailId: "detail-canonical", detail: collectedDetail }
    }, { jobId: firstJob, owner: "worker-first", leaseToken: firstClaim!.leaseToken });
    await jobs.complete(firstJob, "worker-first", firstClaim!.leaseToken, new Date());

    const duplicateJob = await jobs.enqueue({ kind: "miaoshou_collect", businessKey: "canonical:duplicate", payload: { version: 1 } });
    const duplicateClaim = await jobs.claim("worker-duplicate", new Date(), 30_000);
    const duplicate = await pipeline.saveCollected({
      batchId: "batch-duplicate", sourceUrl: collectedDetail.sourceUrl,
      result: { fetchDetailId: null, skippedDetailId: "skip-duplicate", canonicalSuccessDetailId: "detail-canonical", detail: collectedDetail }
    }, { jobId: duplicateJob, owner: "worker-duplicate", leaseToken: duplicateClaim!.leaseToken });

    expect(duplicate?.revisionId).toBe(first?.revisionId);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM products WHERE source_item_id = 'source-canonical'")).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM product_revisions WHERE product_id = (SELECT id FROM products WHERE source_item_id = 'source-canonical')")).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM miaoshou_source_records WHERE source_item_id = 'source-canonical'")).rows[0]?.count)).toBe(2);
  });

  test("reuses listing, pricing and Canvas result rows after write-before-complete recovery", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "durable-results", displayName: "Durable Results" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/durable.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "durable", workingDraft: {} });
    const invokeTwice = async (kind: string, write: (fence: { jobId: string; owner: string; leaseToken: string }) => Promise<boolean>) => {
      for (const suffix of ["first", "restart"]) {
        const id = await jobs.enqueue({ kind, businessKey: `${kind}:${suffix}`, payload: { version: 1, revisionId } });
        const claim = await jobs.claim(`worker-${suffix}`, new Date(), 30_000);
        expect(await write({ jobId: id, owner: `worker-${suffix}`, leaseToken: claim!.leaseToken })).toBe(true);
        await jobs.complete(id, `worker-${suffix}`, claim!.leaseToken, new Date());
      }
    };
    await invokeTwice("listing_generate", (fence) => pipeline.saveResult({ revisionId, title: "Title", description: "Description", attributes: [], styleApplied: "neutral", provider: "rules", fallbackUsed: true }, fence));
    await invokeTwice("pricing_calculate", (fence) => pipeline.saveReady({ revisionId, finalPrice: { amountMinor: "999", currency: "THB" }, breakdown: { ending: "9" } }, fence));
    await handle.pool.query("UPDATE product_revisions SET working_draft = working_draft || '{\"templateMatch\":{\"templateId\":\"default\",\"templateVersion\":1}}'::jsonb WHERE id = $1", [revisionId]);
    await invokeTwice("canvas_generate", (fence) => pipeline.saveOutputs({ revisionId, remoteTaskId: "remote-1", outputs: [{ url: "https://out/1.jpg" }], state: "succeeded" }, fence));
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM listing_drafts WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM pricing_runs WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM canvas_runs WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
  });
});

describe("integration: job repository claim semantics", () => {
  test("enqueue and idempotent reuse append redacted audits in the same transaction", async () => {
    const input = {
      kind: "pricing_calculate",
      businessKey: "audit:job",
      payload: { version: 1 },
      audit: {
        actorType: "operator" as const,
        actorId: "local",
        action: "job.enqueue",
        targetKind: "job",
        payload: { source: "start-button" }
      }
    };
    const first = await jobs.enqueue(input);
    const second = await jobs.enqueue(input);
    expect(second).toBe(first);
    const events = await handle.pool.query(
      "SELECT target_id, payload, redacted FROM audit_events WHERE action = 'job.enqueue' ORDER BY created_at",
    );
    expect(events.rows).toEqual([
      { target_id: first, payload: { source: "start-button" }, redacted: true },
      { target_id: first, payload: { source: "start-button" }, redacted: true }
    ]);
  });

  test("persists a remote task only for the current owner and lease token", async () => {
    const id = await jobs.enqueue({ kind: "canvas_generate", businessKey: "canvas:persist-remote", payload: { version: 1 }, batchKey: "batch-remote" });
    const claimed = await jobs.claim("worker-a", new Date("2026-07-16T00:00:00Z"), 30_000);
    expect(claimed).toMatchObject({ jobId: id, batchKey: "batch-remote" });
    expect(await jobs.persistRemoteTask(id, "worker-b", claimed!.leaseToken, new Date("2026-07-16T00:00:01Z"), "remote-bad")).toBe(false);
    expect(await jobs.persistRemoteTask(id, "worker-a", claimed!.leaseToken, new Date("2026-07-16T00:00:01Z"), "remote-good")).toBe(true);
    const stored = await handle.pool.query("SELECT remote_task_id FROM jobs WHERE id = $1", [id]);
    expect(stored.rows[0]?.remote_task_id).toBe("remote-good");
  });

  test("rolls back a newly inserted job when its same-transaction audit cannot serialize", async () => {
    await expect(jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "audit:rollback",
      payload: { version: 1 },
      audit: {
        actorType: "operator",
        action: "job.enqueue",
        targetKind: "job",
        payload: { safeValue: 1n }
      }
    })).rejects.toThrow();
    const count = await handle.pool.query("SELECT count(*)::int AS count FROM jobs WHERE business_key = 'audit:rollback'");
    expect(count.rows[0].count).toBe(0);
  });

  test("rejects secrets and raw transport data from audit payloads", async () => {
    await expect(jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "audit:secret",
      payload: { version: 1 },
      audit: {
        actorType: "operator",
        action: "job.enqueue",
        targetKind: "job",
        payload: { authorizationHeader: "Bearer secret" }
      }
    })).rejects.toThrow(/audit payload/i);
  });

  test("global and batch pause/resume are persisted and block claims", async () => {
    const batchJob = await jobs.enqueue({ kind: "pricing_calculate", businessKey: "control:batch", batchKey: "batch-1", payload: { version: 1 } });
    await jobs.setGlobalPaused(true);
    expect(await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000)).toBeNull();
    await jobs.setGlobalPaused(false);
    expect(await jobs.pauseBatch("batch-1", "operator_pause")).toBe(1);
    expect(await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000)).toBeNull();
    expect(await jobs.resumeBatch("batch-1")).toBe(1);
    expect((await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000))?.jobId).toBe(batchJob);
  });

  test("task cancel and safe retry are persisted while external unknown results cannot be retried", async () => {
    const cancelled = await jobs.enqueue({ kind: "pricing_calculate", businessKey: "control:cancel", payload: { version: 1 } });
    expect(await jobs.cancel(cancelled, "operator_cancelled")).toBe(true);
    let row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [cancelled]);
    expect(row.rows[0]).toMatchObject({ status: "failed", error: { code: "cancelled" } });
    expect(await jobs.retrySafe(cancelled, new Date("2026-07-16T00:00:00Z"))).toBe(true);
    row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [cancelled]);
    expect(row.rows[0]).toMatchObject({ status: "queued", error: null });

    const external = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:external", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = 'remote-1', error = '{\"code\":\"reconcile_required\"}'::jsonb WHERE id = $1", [external]);
    expect(await jobs.retrySafe(external, new Date("2026-07-16T00:00:00Z"))).toBe(false);

    const unknownWithoutRemoteId = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:unknown-without-id", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = NULL, error = '{\"code\":\"reconcile_required\"}'::jsonb WHERE id = $1", [unknownWithoutRemoteId]);
    expect(await jobs.retrySafe(unknownWithoutRemoteId, new Date("2026-07-16T00:00:00Z"))).toBe(false);
  });

  test("two concurrent claims with same owner/now/lease return only ONE job", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/456.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });

    // Sequential double-claim invariant (brief: "concurrent two-worker simulation if
    // feasible without timing flakiness, else by sequential double-claim"). Only one
    // queued job is available; the second claim must observe it as running and return null.
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: `pricing:${revId}:only`,
      payload: { version: 1, revisionId: revId },
      maxAttempts: 3
    });

    const owner = "worker-A";
    const now = new Date("2026-07-01T00:00:00Z");
    const leaseMs = 30_000;
    const first = await jobs.claim(owner, now, leaseMs);
    const second = await jobs.claim(owner, now, leaseMs);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("with many queued jobs, a second claim immediately returns ONE more job (race safety)", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/456b.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });

    for (let i = 0; i < 5; i++) {
      await jobs.enqueue({
        kind: "pricing_calculate",
        businessKey: `pricing:${revId}:burst:${i}`,
        payload: { version: 1, revisionId: revId },
        maxAttempts: 3
      });
    }

    const owner = "worker-A";
    const now = new Date("2026-07-01T00:00:00Z");
    const leaseMs = 30_000;
    const first = await jobs.claim(owner, now, leaseMs);
    const second = await jobs.claim(owner, now, leaseMs);

    expect(first).not.toBeNull();
    // With multiple queued jobs, second claim MUST pick a different row (not the same).
    expect(second).not.toBeNull();
    expect(second!.jobId).not.toBe(first!.jobId);
  });

  test("a stale lease owner cannot heartbeat, complete, or fail a re-claimed job", async () => {
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "lease:fencing",
      payload: { version: 1, revisionId: "rev-fencing" }
    });
    const first = await jobs.claim("worker-old", new Date("2026-07-01T00:00:00Z"), 1_000);
    expect(first).not.toBeNull();
    await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));
    const second = await jobs.claim("worker-new", new Date("2026-07-01T00:00:02Z"), 30_000);
    expect(second).not.toBeNull();
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    await expect(
      jobs.heartbeat(first!.jobId, "worker-old", first!.leaseToken, new Date("2026-07-01T00:00:03Z"), 1_000)
    ).resolves.toBe(false);
    await expect(
      jobs.complete(first!.jobId, "worker-old", first!.leaseToken, new Date("2026-07-01T00:00:03Z"))
    ).resolves.toBe(false);
    await expect(
      jobs.fail(
        first!.jobId,
        "worker-old",
        first!.leaseToken,
        new Date("2026-07-01T00:00:03Z"),
        { code: "stale" }
      )
    ).resolves.toBe(false);
    await expect(
      jobs.complete(second!.jobId, "worker-new", second!.leaseToken, new Date("2026-07-01T00:00:03Z"))
    ).resolves.toBe(true);
  });

  test("lease owner is fenced after expiry even before releaseExpired runs", async () => {
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "lease:expired-window",
      payload: { version: 1 }
    });
    const claim = await jobs.claim("worker-a", new Date("2026-07-01T00:00:00Z"), 1_000);
    expect(claim).not.toBeNull();
    const expiredAt = new Date("2026-07-01T00:00:01Z");
    await expect(
      jobs.heartbeat(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt, 30_000)
    ).resolves.toBe(false);
    await expect(
      jobs.complete(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt)
    ).resolves.toBe(false);
    await expect(
      jobs.fail(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt, { code: "late" })
    ).resolves.toBe(false);
    const row = await handle.pool.query("SELECT status, owner FROM jobs WHERE id = $1", [claim!.jobId]);
    expect(row.rows[0]).toMatchObject({ status: "running", owner: "worker-a" });
  });

  test("claim respects next_attempt_at and max_attempts", async () => {
    const futureId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "retry:future",
      payload: { version: 1 },
      maxAttempts: 3
    });
    const exhaustedId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "retry:exhausted",
      payload: { version: 1 },
      maxAttempts: 1
    });
    await handle.pool.query("UPDATE jobs SET next_attempt_at = $2 WHERE id = $1", [
      futureId,
      new Date("2026-07-02T00:00:00Z")
    ]);
    await handle.pool.query("UPDATE jobs SET attempt = max_attempts WHERE id = $1", [exhaustedId]);
    expect(await jobs.claim("worker", new Date("2026-07-01T00:00:00Z"), 30_000)).toBeNull();
  });

  test("expired external-side-effect jobs go to reconciliation instead of being requeued", async () => {
    const externalId = await jobs.enqueue({
      kind: "canvas_generate",
      businessKey: "external:canvas",
      payload: { version: 1 }
    });
    const safeId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "internal:pricing",
      payload: { version: 1 }
    });
    const now = new Date("2026-07-01T00:00:00Z");
    const external = await jobs.claim("worker-a", now, 1_000);
    const safe = await jobs.claim("worker-a", now, 1_000);
    expect(new Set([external!.jobId, safe!.jobId])).toEqual(new Set([externalId, safeId]));
    await handle.pool.query("UPDATE jobs SET remote_task_id = 'remote-123' WHERE id = $1", [externalId]);

    expect(await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"))).toBe(2);
    const result = await handle.pool.query(
      "SELECT id, status, error FROM jobs WHERE id = ANY($1::text[]) ORDER BY id",
      [[externalId, safeId]]
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get(externalId).status).toBe("needs_input");
    expect(byId.get(externalId).error.code).toBe("reconcile_required");
    expect(byId.get(safeId).status).toBe("queued");
  });

  test("expired miaoshou edit also marks its aggregate result_unknown", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/sync.html",
      sourceItemId: "sync",
      locale: "th-TH",
      currency: "THB"
    });
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "ready",
      workingDraft: {}
    });
    const snapshotId = "appr-expired-sync";
    await handle.pool.query(
      `INSERT INTO approval_snapshots
        (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
         template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
         source_item_id, canonical_success_detail_id, locale, currency, title, description,
         attributes, price_minor, price_currency, stock, weight_kg, skus, state)
       VALUES ($1, $2, $3, 1, 'listing-1', 'pricing-1', 1, '[]'::jsonb, '1688',
               'https://detail.1688.com/offer/sync.html', 'sync', 'canonical-1',
               'th-TH', 'THB', 'title', 'description', '[]'::jsonb, '100', 'THB', 1,
               '0.3', '[]'::jsonb, 'approved')`,
      [snapshotId, productId, revisionId]
    );
    await handle.pool.query(
      "INSERT INTO miaoshou_syncs (id, approval_snapshot_id, state) VALUES ('sync-expired', $1, 'syncing')",
      [snapshotId]
    );
    const jobId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: "miaoshou-edit:expired",
      payload: { version: 1, approvalSnapshotId: snapshotId }
    });
    await jobs.claim("worker-a", new Date("2026-07-01T00:00:00Z"), 1_000);

    await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));
    const [job, sync] = await Promise.all([
      handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [jobId]),
      handle.pool.query("SELECT state, error FROM miaoshou_syncs WHERE approval_snapshot_id = $1", [snapshotId])
    ]);
    expect(job.rows[0].status).toBe("needs_input");
    expect(job.rows[0].error.code).toBe("reconcile_required");
    expect(sync.rows[0].state).toBe("result_unknown");
    expect(sync.rows[0].error.code).toBe("reconcile_required");
  });

  test.each(["succeeded", "failed"] as const)(
    "expired miaoshou edit does not downgrade terminal sync state %s",
    async (terminalState) => {
      const operatorId = await catalog.upsertLocalOperator({
        handle: `terminal-${terminalState}`,
        displayName: `Terminal ${terminalState}`
      });
      const productId = await catalog.insertProduct({
        operatorId,
        sourceUrl: `https://detail.1688.com/offer/terminal-${terminalState}.html`,
        sourceItemId: `terminal-${terminalState}`,
        locale: "th-TH",
        currency: "THB"
      });
      const revisionId = await catalog.insertRevision({
        productId,
        draftVersion: 1,
        sourceTitle: "terminal",
        workingDraft: {}
      });
      const snapshotId = `appr-terminal-${terminalState}`;
      await handle.pool.query(
        `INSERT INTO approval_snapshots
          (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
           template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
           source_item_id, canonical_success_detail_id, locale, currency, title, description,
           attributes, price_minor, price_currency, stock, weight_kg, skus, state)
         VALUES ($1, $2, $3, 1, 'listing-terminal', 'pricing-terminal', 1, '[]'::jsonb,
                 '1688', $4, $5, 'canonical-terminal', 'th-TH', 'THB', 'title',
                 'description', '[]'::jsonb, '100', 'THB', 1, '0.3', '[]'::jsonb,
                 'approved')`,
        [
          snapshotId,
          productId,
          revisionId,
          `https://detail.1688.com/offer/terminal-${terminalState}.html`,
          `terminal-${terminalState}`
        ]
      );
      await handle.pool.query(
        `INSERT INTO miaoshou_syncs (id, approval_snapshot_id, state, error)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          `sync-terminal-${terminalState}`,
          snapshotId,
          terminalState,
          JSON.stringify({ code: `terminal_${terminalState}` })
        ]
      );
      const jobId = await jobs.enqueue({
        kind: "miaoshou_edit",
        businessKey: `miaoshou-edit:terminal:${terminalState}`,
        payload: { version: 1, approvalSnapshotId: snapshotId }
      });
      const claim = await jobs.claim(
        "worker-terminal",
        new Date("2026-07-01T00:00:00Z"),
        1_000
      );
      expect(claim?.jobId).toBe(jobId);

      await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));

      const sync = await handle.pool.query(
        "SELECT state, error FROM miaoshou_syncs WHERE approval_snapshot_id = $1",
        [snapshotId]
      );
      expect(sync.rows[0]).toEqual({
        state: terminalState,
        error: { code: `terminal_${terminalState}` }
      });
    }
  );
});

describe("integration: Canvas daily quota", () => {
  test("atomically caps concurrent reservations and reuses a run reservation", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      canvasQuota.reserve({ runKey: `run-${index}`, day: "2026-07-16", limit: 2 })
    ));
    expect(results.filter(Boolean)).toHaveLength(2);
    const winner = results.findIndex(Boolean);
    expect(await canvasQuota.reserve({ runKey: `run-${winner}`, day: "2026-07-16", limit: 2 })).toBe(true);
    const rows = await handle.pool.query("SELECT run_key FROM canvas_daily_reservations WHERE day_key = '2026-07-16'");
    expect(rows.rowCount).toBe(2);
  });
});

describe("integration: exchange rate snapshots", () => {
  test("records source, observedAt, manual override provenance", async () => {
    const observedAt = "2026-07-01T00:00:00.000Z";
    await rates.record({
      base: "CNY",
      target: "THB",
      rate: "4.80",
      source: "provider",
      observedAt,
      isStale: false
    });
    await rates.recordManualOverride({
      base: "CNY",
      target: "THB",
      rate: "5.00",
      observedAt
    });

    const all = await rates.listAll();
    const provider = all.find((s) => s.source === "provider");
    const manual = all.find((s) => s.source === "manual");
    expect(provider).toBeDefined();
    expect(manual).toBeDefined();
    expect(provider!.rate).toBe("4.80");
    expect(manual!.rate).toBe("5.00");
    expect(await rates.latestEffective("CNY", "THB")).toMatchObject({ id: manual!.id, source: "manual", rate: "5.00" });
    expect(await rates.markStale(provider!.id)).toBe(true);
    expect(await rates.latestSuccessful("CNY", "THB")).toMatchObject({ id: manual!.id, source: "manual", isStale: false });
  });
});

describe("integration: automation run repository", () => {
  test("concurrent createOrReuseAndEnqueue creates one run and one asset archive job", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/789.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });

    const [first, second] = await Promise.all([
      automations.createOrReuseAndEnqueue({ revisionId: revId, processingVersion: 1 }),
      automations.createOrReuseAndEnqueue({ revisionId: revId, processingVersion: 1 })
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.runId).toBe(second.runId);

    const runs = await handle.pool.query(
      "SELECT id FROM automation_runs WHERE revision_id = $1 AND processing_version = 1",
      [revId]
    );
    const queued = await handle.pool.query(
      "SELECT kind, payload FROM jobs WHERE business_key = $1",
      [`automation:${first.runId}:boot`]
    );
    expect(runs.rowCount).toBe(1);
    expect(queued.rowCount).toBe(1);
    expect(queued.rows[0].kind).toBe("asset_archive");
    expect(queued.rows[0].payload).toEqual({ version: 1, revisionId: revId, remoteUrls: [] });
  });

  test("records every repeated human start against the reused run", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "audit-start", displayName: "Audit Start" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/audit.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "audit", workingDraft: {} });
    const input = {
      revisionId,
      processingVersion: 1,
      audit: {
        actorType: "operator" as const,
        actorId: "local",
        action: "automation.start",
        targetKind: "automation_run",
        payload: { surface: "product-workbench" }
      }
    };
    const first = await automations.createOrReuseAndEnqueue(input);
    const second = await automations.createOrReuseAndEnqueue(input);
    expect(second.runId).toBe(first.runId);
    const events = await handle.pool.query("SELECT target_id FROM audit_events WHERE action = 'automation.start'");
    expect(events.rows.map((row) => row.target_id)).toEqual([first.runId, first.runId]);
  });

  test("rolls back automation run and boot job when same-transaction audit fails", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "audit-run-rollback", displayName: "Audit rollback" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/rollback.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "rollback", workingDraft: {} });
    await expect(automations.createOrReuseAndEnqueue({
      revisionId,
      processingVersion: 1,
      audit: { actorType: "operator", action: "automation.start", targetKind: "automation_run", payload: { safeValue: 1n } }
    })).rejects.toThrow();
    const [runs, queued] = await Promise.all([
      handle.pool.query("SELECT count(*)::int AS count FROM automation_runs WHERE revision_id = $1", [revisionId]),
      handle.pool.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'revisionId' = $1", [revisionId])
    ]);
    expect(runs.rows[0].count).toBe(0);
    expect(queued.rows[0].count).toBe(0);
  });
});

describe("integration: ApprovalRepository.confirmAndEnqueue fail-closed boundary", () => {
  test("rejects incomplete mapping without snapshot, sync, or job writes", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/abc.html",
      locale: "th-TH",
      currency: "THB"
    });
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedPricingRunId: "run-pricing-1",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    };
    await expect(approvals.confirmAndEnqueue(command)).rejects.toBeInstanceOf(
      ApprovalNotReadyError
    );
    const [snapshots, syncs, queued] = await Promise.all([
      handle.pool.query("SELECT count(*)::int AS count FROM approval_snapshots"),
      handle.pool.query("SELECT count(*)::int AS count FROM miaoshou_syncs"),
      handle.pool.query("SELECT count(*)::int AS count FROM jobs")
    ]);
    expect(snapshots.rows[0].count).toBe(0);
    expect(syncs.rows[0].count).toBe(0);
    expect(queued.rows[0].count).toBe(0);
  });
});
