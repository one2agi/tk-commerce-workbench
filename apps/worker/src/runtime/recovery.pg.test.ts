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
      repository: {
        loadSnapshot: vi.fn(async () => approvalSnapshot),
        saveSucceeded: vi.fn(async () => true),
        saveValidationFailure: vi.fn(async () => true),
        saveResultUnknown: vi.fn(async () => true),
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
