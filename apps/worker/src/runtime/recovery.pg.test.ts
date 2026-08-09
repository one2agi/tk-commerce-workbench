import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ApprovalSnapshotV1, AssetStagingPort, MiaoshouEditPort } from "@tk/contracts";
import { createFakePorts } from "@tk/contracts/testing";
import { INITIAL_SQL, JobRepository, bootTestDb, type TestDbHandle } from "@tk/db";

import { createCanvasHandler } from "../handlers/generate-canvas.js";
import { createMiaoshouEditHandler } from "../handlers/miaoshou-edit.js";
import { adaptLeasedJobRepository, runWorkerLoop, type WorkerHandler } from "./worker-loop.js";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

async function persistAcceptedRemoteThenExpire(kind: "canvas_generate" | "miaoshou_edit", remoteMarker: string) {
  const beforeCrash = new JobRepository(handle.pool);
  const claimedAt = new Date("2026-07-17T00:00:00.000Z");
  const jobId = await beforeCrash.enqueue({
    kind,
    businessKey: `${kind}:hard-crash:${remoteMarker}`,
    payload: { version: 1, approvalSnapshotId: "approval-current", revisionId: "revision-current" }
  });
  const crashedClaim = await beforeCrash.claim("runtime-before-hard-crash", claimedAt, 25);
  expect(crashedClaim?.jobId).toBe(jobId);

  // Production handlers persist this marker before their final local success
  // transaction. The process disappears here: no complete/fail call is made.
  expect(await beforeCrash.persistRemoteTask(
    jobId,
    "runtime-before-hard-crash",
    crashedClaim!.leaseToken,
    claimedAt,
    remoteMarker
  )).toBe(true);
  const persistedBeforeRestart = await handle.pool.query(
    "SELECT status, owner, remote_task_id FROM jobs WHERE id = $1",
    [jobId]
  );
  expect(persistedBeforeRestart.rows[0]).toEqual({
    status: "running",
    owner: "runtime-before-hard-crash",
    remote_task_id: remoteMarker
  });

  const restartedAt = new Date(claimedAt.getTime() + 50);
  const afterRestart = new JobRepository(handle.pool);
  expect(await afterRestart.releaseExpired(restartedAt)).toBe(1);
  const released = await handle.pool.query(
    "SELECT status, owner, lease_token, remote_task_id, error FROM jobs WHERE id = $1",
    [jobId]
  );
  expect(released.rows[0]).toMatchObject({
    status: "needs_input",
    owner: null,
    lease_token: null,
    remote_task_id: remoteMarker,
    error: { kind: "reconcile_required", code: "reconcile_required" }
  });
  return { afterRestart, jobId, restartedAt };
}

async function runFreshRuntime(input: {
  jobs: JobRepository;
  kind: "canvas_generate" | "miaoshou_edit";
  handler: WorkerHandler;
  now: Date;
}) {
  await runWorkerLoop({
    jobs: adaptLeasedJobRepository(input.jobs),
    handlers: { [input.kind]: input.handler },
    clock: { now: () => input.now },
    workerId: "fresh-runtime-after-hard-crash",
    leaseMs: 30_000,
    maxJobs: 1
  });
}

async function expectRecoveredJob(jobId: string, remoteMarker: string) {
  const completed = await handle.pool.query(
    "SELECT status, owner, lease_token, remote_task_id FROM jobs WHERE id = $1",
    [jobId]
  );
  expect(completed.rows[0]).toEqual({
    status: "succeeded",
    owner: null,
    lease_token: null,
    remote_task_id: remoteMarker
  });
}

const approvalSnapshot = {
  approvalSnapshotId: "approval-current",
  productId: "product-current",
  revisionId: "revision-current",
  draftVersion: 1,
  listingRunId: "listing-current",
  pricingRunId: "pricing-current",
  templateVersion: 1,
  orderedFinalAssetIds: ["asset-current"],
  sourcePlatform: "1688",
  sourceCanonicalUrl: "https://detail.1688.com/offer/892408514788.html",
  sourceItemId: "892408514788",
  canonicalSuccessDetailId: "3799770548",
  locale: "th-TH",
  currency: "THB",
  title: "title",
  description: "description",
  attributes: [],
  priceWire: { amountMinor: "9900", currency: "THB" },
  stock: 10,
  weightKg: "0.5",
  skus: [],
  createdAt: "2026-07-17T00:00:00.000Z"
} as unknown as ApprovalSnapshotV1;

describe("real PostgreSQL hard-crash recovery through production handlers", () => {
  it("persists a stable Canvas submit intent before the paid call and never submits again after a response-to-database crash", async () => {
    const jobs = new JobRepository(handle.pool);
    let now = new Date("2026-07-18T00:00:00.000Z");
    const jobId = await jobs.enqueue({
      kind: "canvas_generate",
      businessKey: "canvas_generate:response-before-remote-id",
      payload: { version: 1, revisionId: "revision-intent" }
    });
    const ports = createFakePorts();
    let submitCalls = 0;
    ports.canvas.submit = vi.fn(async () => {
      submitCalls += 1;
      // The paid request was accepted, but this worker loses its fence before it
      // can persist Canvas' remote task id. This models a hard process stop at
      // the exact response-to-local-write boundary without making a real call.
      await handle.pool.query(
        "UPDATE jobs SET lease_expires_at = $2::timestamptz WHERE id = $1",
        [jobId, new Date("2026-07-17T23:59:59.999Z")]
      );
      now = new Date("2026-07-18T00:00:00.050Z");
      expect(await jobs.releaseExpired(now)).toBe(1);
      return { remoteTaskId: "canvas-accepted-but-not-persisted", submittedAt: now.toISOString() };
    });
    const handler = createCanvasHandler({
      canvas: ports.canvas,
      staging: ports.assetStaging,
      store: { archive: vi.fn() },
      repository: {
        loadPlan: vi.fn(async () => ({
          workflowId: "TKWorkflow",
          templateVersion: 7,
          productImages: [{ assetId: "asset-intent", url: "local:asset-intent", role: "primary" as const, score: 1, perceptualHash: "intent" }],
          referenceAssetIds: [],
          localAssetIds: ["asset-intent"],
          sourceLocale: "zh-CN",
          targetLocale: "th-TH",
          style: "clean",
          promptFragment: "",
          expectedOutputCount: 5
        })),
        saveOutputs: vi.fn(async () => true)
      },
      quota: { reserve: vi.fn(async () => true) },
      audit: { append: vi.fn(async () => undefined) },
      now: () => now,
      cleanupCodec: { protect: vi.fn(() => "protected"), unprotect: vi.fn(() => ({ remoteUrls: [], expiresAt: now.toISOString() })) },
      maxRunsPerDay: 1
    });

    await runWorkerLoop({
      jobs: adaptLeasedJobRepository(jobs),
      handlers: { canvas_generate: handler },
      clock: { now: () => now },
      workerId: "runtime-crashes-after-canvas-response",
      leaseMs: 25,
      maxJobs: 1
    });

    const afterCrash = await handle.pool.query(
      "SELECT status, remote_task_id, payload, error FROM jobs WHERE id = $1",
      [jobId]
    );
    expect(afterCrash.rows[0]).toMatchObject({
      status: "needs_input",
      remote_task_id: null,
      payload: {
        reconciliationIntent: {
          version: 1,
          operation: "canvas_submit",
          idempotencyKey: "canvas:revision-intent:7",
          revisionId: "revision-intent",
          workflowId: "TKWorkflow",
          workflowVersion: 1,
          templateVersion: 7
        }
      },
      error: { kind: "reconcile_required", code: "reconcile_required" }
    });

    // Even if an older operator/tool incorrectly puts this row back in the
    // queue, the production handler itself must observe the durable intent and
    // fail closed before capacity, staging or another paid submit.
    await handle.pool.query("UPDATE jobs SET status = 'queued', error = NULL WHERE id = $1", [jobId]);
    now = new Date("2026-07-18T00:00:01.000Z");
    await runWorkerLoop({
      jobs: adaptLeasedJobRepository(new JobRepository(handle.pool)),
      handlers: { canvas_generate: handler },
      clock: { now: () => now },
      workerId: "runtime-after-canvas-response-crash",
      leaseMs: 25,
      maxJobs: 1
    });
    expect(submitCalls).toBe(1);
    expect(ports.canvas.calls.filter((call) => call.method === "fetchOutputs")).toHaveLength(0);
    const afterGuard = await handle.pool.query("SELECT status, remote_task_id, payload, error FROM jobs WHERE id = $1", [jobId]);
    expect(afterGuard.rows[0]).toMatchObject({
      status: "needs_input",
      remote_task_id: null,
      payload: { reconciliationIntent: { operation: "canvas_submit", idempotencyKey: "canvas:revision-intent:7" } },
      error: { kind: "reconcile_required", code: "reconcile_required" }
    });
    await handle.pool.query("UPDATE jobs SET status = 'succeeded' WHERE status = 'queued'");
  });

  it("atomically replaces a Canvas submit intent with the real remote task id after a normal response", async () => {
    const jobs = new JobRepository(handle.pool);
    const now = new Date("2026-07-18T01:00:00.000Z");
    const jobId = await jobs.enqueue({
      kind: "canvas_generate",
      businessKey: "canvas_generate:normal-response",
      payload: { version: 1, revisionId: "revision-normal" }
    });
    const claim = await jobs.claim("runtime-normal-response", now, 30_000);
    expect(claim?.jobId).toBe(jobId);
    expect(await jobs.persistReconciliationIntent(jobId, "runtime-normal-response", claim!.leaseToken, now, {
      version: 1,
      operation: "canvas_submit",
      idempotencyKey: "canvas:revision-normal:3",
      revisionId: "revision-normal",
      workflowId: "TKWorkflow",
      workflowVersion: 1,
      templateVersion: 3
    })).toBe(true);
    expect(await jobs.persistReconciliationIntent(jobId, "runtime-normal-response", claim!.leaseToken, now, {
      version: 1,
      operation: "canvas_submit",
      idempotencyKey: "canvas:revision-normal:DIFFERENT"
    })).toBe(false);
    expect(await jobs.persistRemoteTask(
      jobId,
      "runtime-normal-response",
      claim!.leaseToken,
      now,
      "canvas-real-remote-task"
    )).toBe(true);

    const persisted = await handle.pool.query("SELECT remote_task_id, payload FROM jobs WHERE id = $1", [jobId]);
    expect(persisted.rows[0]).toEqual({
      remote_task_id: "canvas-real-remote-task",
      payload: { version: 1, revisionId: "revision-normal" }
    });
    expect(await jobs.complete(jobId, "runtime-normal-response", claim!.leaseToken, now)).toBe(true);
  });

  it("expires a crashed Canvas lease and the production handler fetches outputs without submitting again", async () => {
    const remoteMarker = "canvas-task:TK:accepted-once";
    const { afterRestart, jobId, restartedAt } = await persistAcceptedRemoteThenExpire("canvas_generate", remoteMarker);
    const ports = createFakePorts();
    const saveOutputs = vi.fn(async () => true);
    const handler = createCanvasHandler({
      canvas: ports.canvas,
      staging: ports.assetStaging,
      store: {
        archive: vi.fn(async (remoteUrl: string) => ({
          remoteUrl,
          finalUrl: remoteUrl,
          sha256: `local-${remoteUrl.split("/").at(-1)}`,
          path: `/data/assets/${remoteUrl.split("/").at(-1)}`,
          extension: "png",
          bytes: 16
        }))
      },
      repository: {
        loadPlan: vi.fn(async () => ({
          workflowId: "TKWorkflow",
          templateVersion: 1,
          productImages: [],
          referenceAssetIds: [],
          localAssetIds: [],
          sourceLocale: "zh-CN",
          targetLocale: "th-TH",
          style: "clean",
          promptFragment: "",
          expectedOutputCount: 5
        })),
        saveOutputs
      },
      quota: { reserve: vi.fn(async () => true) },
      audit: { append: vi.fn(async () => undefined) },
      now: () => restartedAt,
      cleanupCodec: { protect: vi.fn(() => "protected"), unprotect: vi.fn(() => ({ remoteUrls: [], expiresAt: restartedAt.toISOString() })) },
      maxRunsPerDay: 1
    });

    await runFreshRuntime({ jobs: afterRestart, kind: "canvas_generate", handler, now: restartedAt });

    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(0);
    expect(ports.canvas.calls.filter((call) => call.method === "fetchOutputs")).toEqual([
      { method: "fetchOutputs", input: { remoteTaskId: remoteMarker } }
    ]);
    expect(saveOutputs).toHaveBeenCalledTimes(1);
    await expectRecoveredJob(jobId, remoteMarker);
    // The production Canvas handler correctly creates the next DAG node. This
    // test focuses on recovery, so finish that child before the next case claims.
    await handle.pool.query("UPDATE jobs SET status = 'succeeded' WHERE kind = 'final_preview' AND status = 'queued'");
  });

  it("expires a crashed Miaoshou lease and the production handler reconciles without applying the edit again", async () => {
    const remoteMarker = "canonical:3799770548:accepted-once";
    const { afterRestart, jobId, restartedAt } = await persistAcceptedRemoteThenExpire("miaoshou_edit", remoteMarker);
    const edit = {
      applyEdit: vi.fn(),
      reconcileByCanonicalDetailId: vi.fn().mockResolvedValue({ remoteDetailId: "3799770548", state: "applied" })
    } satisfies MiaoshouEditPort;
    const staging = {
      stage: vi.fn(),
      release: vi.fn()
    } satisfies AssetStagingPort;
    const saveReconciled = vi.fn(async () => true);
    const handler = createMiaoshouEditHandler({
      edit,
      staging,
      publishing: {
        publish: vi.fn(async ({ assets }) => assets.map(({ assetId }: { assetId: string }) => ({
          remoteUrl: `https://published.test/${assetId}`
        }))),
        release: vi.fn(async () => undefined)
      },
      repository: {
        loadSnapshot: vi.fn(async () => approvalSnapshot),
        saveSucceeded: vi.fn(async () => true),
        saveValidationFailure: vi.fn(async () => true),
        saveResultUnknown: vi.fn(async () => true),
        saveReconciliationResultUnknown: vi.fn(async () => true),
        saveReconciled,
        persistReconciliationContext: vi.fn(async () => true)
      },
      reachability: { assertReachable: vi.fn(async () => undefined) },
      cleanupCodec: { protect: vi.fn(() => "protected"), unprotect: vi.fn(() => ({ remoteUrls: [], expiresAt: restartedAt.toISOString() })) },
      audit: { append: vi.fn(async () => undefined) }
    });

    await runFreshRuntime({ jobs: afterRestart, kind: "miaoshou_edit", handler, now: restartedAt });

    expect(edit.applyEdit).not.toHaveBeenCalled();
    expect(staging.stage).not.toHaveBeenCalled();
    expect(edit.reconcileByCanonicalDetailId).toHaveBeenCalledTimes(1);
    expect(edit.reconcileByCanonicalDetailId).toHaveBeenCalledWith({
      canonicalSuccessDetailId: "3799770548",
      sourceItemId: "892408514788"
    });
    expect(saveReconciled).toHaveBeenCalledTimes(1);
    await expectRecoveredJob(jobId, remoteMarker);
  });
});
