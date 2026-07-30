import { describe, expect, it, vi } from "vitest";

import type { MiaoshouSourcePort } from "@tk/contracts";

import type { ClaimedWorkerJob, WorkerExecutionContext } from "../runtime/worker-loop.js";
import { createPrepareMiaoshouWritebackHandler } from "./prepare-miaoshou-writeback.js";

function job(): ClaimedWorkerJob {
  return {
    jobId: "job-prepare-1",
    kind: "miaoshou_prepare_writeback",
    businessKey: "miaoshou-prepare:approval-1",
    payload: {
      version: 1,
      approvalSnapshotId: "approval-1",
      productId: "product-1",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: "miaoshou-prepare:approval-1"
    },
    leaseToken: "lease-1",
    remoteTaskId: null
  };
}

function execution(): WorkerExecutionContext {
  return {
    fence: { jobId: "job-prepare-1", owner: "worker-1", leaseToken: "lease-1" },
    signal: new AbortController().signal,
    assertLease: vi.fn(),
    persistReconciliationIntent: vi.fn(),
    persistRemoteTask: vi.fn(),
    scheduleCompensation: vi.fn()
  };
}

describe("prepare Miaoshou writeback", () => {
  it("imports the 1688 item only after approval and enqueues the edit through a fenced write", async () => {
    const result = {
      fetchDetailId: "detail-fetch",
      skippedDetailId: null,
      canonicalSuccessDetailId: "detail-canonical",
      detail: {
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        title: "source"
      }
    };
    const port = {
      fetchItem: vi.fn(async () => result),
      resolveCanonicalSuccessDetail: vi.fn()
    } as unknown as MiaoshouSourcePort;
    const repository = {
      bindCanonicalAndEnqueueEdit: vi.fn(async () => true)
    };
    const audit = { append: vi.fn(async () => undefined) };
    const handler = createPrepareMiaoshouWritebackHandler({ port, repository, audit });
    const run = execution();

    await expect(handler(job(), run)).resolves.toEqual({ next: [] });

    expect(port.fetchItem).toHaveBeenCalledWith({
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: "miaoshou-prepare:approval-1"
    });
    expect(repository.bindCanonicalAndEnqueueEdit).toHaveBeenCalledWith({
      approvalSnapshotId: "approval-1",
      productId: "product-1",
      result
    }, run.fence);
  });
});
