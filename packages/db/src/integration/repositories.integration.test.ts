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

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.migrate(INITIAL_SQL);
  catalog = new CatalogRepository(handle.pool);
  jobs = new JobRepository(handle.pool);
  rates = new ExchangeRateRepository(handle.pool);
  automations = new AutomationRunRepository(handle.pool);
  approvals = new ApprovalRepository(handle.pool);
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

describe("integration: job repository claim semantics", () => {
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
    await expect(jobs.complete(first!.jobId, "worker-old", first!.leaseToken)).resolves.toBe(false);
    await expect(
      jobs.fail(first!.jobId, "worker-old", first!.leaseToken, { code: "stale" })
    ).resolves.toBe(false);
    await expect(jobs.complete(second!.jobId, "worker-new", second!.leaseToken)).resolves.toBe(true);
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
