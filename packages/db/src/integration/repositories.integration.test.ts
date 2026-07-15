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
import * as schema from "../schema/index.js";
import { CatalogRepository } from "../repositories/catalog-repository.js";
import { JobRepository } from "../repositories/job-repository.js";
import { ExchangeRateRepository } from "../repositories/exchange-rate-repository.js";
import { AutomationRunRepository } from "../repositories/automation-run-repository.js";
import { ApprovalRepository } from "../repositories/approval-repository.js";
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
  await handle.close();
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
  test("createOrReuseAndEnqueue reuses existing run on second call", async () => {
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

    const first = await automations.createOrReuseAndEnqueue({
      revisionId: revId,
      processingVersion: 1
    });
    const second = await automations.createOrReuseAndEnqueue({
      revisionId: revId,
      processingVersion: 1
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.runId).toBe(second.runId);
  });
});

describe("integration: ApprovalRepository.confirmAndEnqueue (frozen transaction boundary)", () => {
  test("returns approvalSnapshotId and syncId", async () => {
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
    const result = await approvals.confirmAndEnqueue(command);
    expect(typeof result.approvalSnapshotId).toBe("string");
    expect(result.approvalSnapshotId.length).toBeGreaterThan(0);
    expect(typeof result.syncId).toBe("string");
    expect(result.syncId.length).toBeGreaterThan(0);
  });

  test("second call with same command inputs is idempotent", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/def.html",
      locale: "th-TH",
      currency: "THB"
    });
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-2",
      expectedPricingRunId: "run-pricing-2",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: ["asset-x", "asset-y"]
    };
    const a = await approvals.confirmAndEnqueue(command);
    const b = await approvals.confirmAndEnqueue(command);
    expect(b.approvalSnapshotId).toBe(a.approvalSnapshotId);
  });
});
