import { describe, expect, it, vi } from "vitest";

import type { ApprovalSnapshotV1, AssetStagingPort, MiaoshouEditPort } from "@tk/contracts";

import { ExternalResultUnknownError, type ClaimedWorkerJob, type WorkerExecutionContext } from "../runtime/worker-loop.js";
import { createMiaoshouEditHandler } from "./miaoshou-edit.js";

const snapshot = {
  approvalSnapshotId: "approval-1",
  productId: "product-1",
  revisionId: "revision-1",
  draftVersion: 2,
  listingRunId: "listing-2",
  pricingRunId: "pricing-2",
  templateVersion: 3,
  orderedFinalAssetIds: ["asset-b", "asset-a"],
  sourcePlatform: "1688",
  sourceCanonicalUrl: "https://detail.1688.com/offer/892408514788.html",
  sourceItemId: "892408514788",
  canonicalSuccessDetailId: "detail-3799770548",
  locale: "th-TH",
  currency: "THB",
  title: "title",
  description: "description",
  attributes: [],
  itemNumber: "item-1",
  priceWire: { amountMinor: "9900", currency: "THB" },
  stock: 10,
  weightKg: "0.5",
  dimensions: { lengthCm: "10", widthCm: "20", heightCm: "3" },
  skus: [],
  createdAt: "2026-07-16T00:00:00.000Z"
} as unknown as ApprovalSnapshotV1;

function job(remoteTaskId: string | null = null): ClaimedWorkerJob {
  return {
    jobId: "job-1",
    kind: "miaoshou_edit",
    businessKey: "approval-1",
    payload: { version: 1, approvalSnapshotId: "approval-1", productId: "product-1", canonicalSuccessDetailId: "detail-3799770548" },
    leaseToken: "lease-1",
    remoteTaskId
  };
}

function execution(): WorkerExecutionContext {
  return {
    fence: { jobId: "job-1", owner: "worker-1", leaseToken: "lease-1" },
    signal: new AbortController().signal,
    assertLease: vi.fn(),
    persistRemoteTask: vi.fn(),
    scheduleCompensation: vi.fn()
  };
}

function dependencies(result: Awaited<ReturnType<MiaoshouEditPort["applyEdit"]>>) {
  const edit = {
    applyEdit: vi.fn().mockResolvedValue(result),
    reconcileByCanonicalDetailId: vi.fn().mockResolvedValue({ remoteDetailId: "detail-3799770548", state: "applied" })
  } satisfies MiaoshouEditPort;
  const staging = {
    stage: vi.fn().mockResolvedValue([
      { remoteUrl: "https://stage.test/asset-b", expiresAt: "2026-07-16T01:00:00Z" },
      { remoteUrl: "https://stage.test/asset-a", expiresAt: "2026-07-16T01:00:00Z" }
    ]),
    release: vi.fn().mockResolvedValue(undefined)
  } satisfies AssetStagingPort;
  const repository = {
    loadSnapshot: vi.fn().mockResolvedValue(snapshot),
    saveSucceeded: vi.fn().mockResolvedValue(true),
    saveValidationFailure: vi.fn().mockResolvedValue(true),
    saveResultUnknown: vi.fn().mockResolvedValue(true),
    saveReconciled: vi.fn().mockResolvedValue(true),
    persistReconciliationContext: vi.fn().mockResolvedValue(true)
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const reachability = { assertReachable: vi.fn().mockResolvedValue(undefined) };
  return { edit, staging, repository, audit, reachability };
}

describe("createMiaoshouEditHandler", () => {
  it("stages approved assets in their frozen order, checks reachability and releases them", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "remote-1" });
    const handler = createMiaoshouEditHandler(deps);
    const run = execution();

    await expect(handler(job(), run)).resolves.toEqual({ next: [] });

    expect(run.persistRemoteTask).toHaveBeenCalledWith("canonical:detail-3799770548");
    expect(deps.repository.persistReconciliationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        approvalSnapshotId: "approval-1",
        canonicalSuccessDetailId: "detail-3799770548",
        sourceItemId: "892408514788",
        orderedRemoteAssetUrls: ["https://stage.test/asset-b", "https://stage.test/asset-a"],
        expectedDetail: expect.objectContaining({ title: "title", imgUrls: ["https://stage.test/asset-b", "https://stage.test/asset-a"] })
      }),
      expect.any(Object)
    );
    const persistedMarker = vi.mocked(run.persistRemoteTask);
    expect(deps.repository.persistReconciliationContext.mock.invocationCallOrder[0])
      .toBeLessThan(persistedMarker.mock.invocationCallOrder[0]!);
    expect(persistedMarker.mock.invocationCallOrder[0]).toBeLessThan(deps.edit.applyEdit.mock.invocationCallOrder[0]!);
    expect(deps.staging.stage).toHaveBeenCalledWith({ localAssetIds: ["asset-b", "asset-a"], purpose: "miaoshou_edit" });
    expect(deps.reachability.assertReachable).toHaveBeenCalledWith(["https://stage.test/asset-b", "https://stage.test/asset-a"]);
    expect(deps.edit.applyEdit).toHaveBeenCalledWith(expect.objectContaining({
      approvalSnapshot: snapshot,
      orderedRemoteAssetUrls: ["https://stage.test/asset-b", "https://stage.test/asset-a"],
      idempotencyKey: "miaoshou-edit:approval-1"
    }));
    expect(deps.repository.saveSucceeded).toHaveBeenCalledWith("approval-1", "remote-1", expect.any(Object));
    expect(deps.staging.release).toHaveBeenCalledWith({ remoteUrls: ["https://stage.test/asset-b", "https://stage.test/asset-a"] });
  });

  it("turns a crash after remote acceptance but before local save into reconciliation-only recovery", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "remote-1" });
    deps.repository.saveSucceeded.mockRejectedValueOnce(new Error("database disconnected after remote acceptance"));
    const handler = createMiaoshouEditHandler(deps);

    await expect(handler(job(), execution())).rejects.toMatchObject({
      remoteTaskId: "canonical:detail-3799770548"
    });
    expect(deps.edit.applyEdit).toHaveBeenCalledTimes(1);

    await handler(job("canonical:detail-3799770548"), execution());
    expect(deps.edit.applyEdit).toHaveBeenCalledTimes(1);
    expect(deps.edit.reconcileByCanonicalDetailId).toHaveBeenCalledTimes(1);
  });

  it("persists field-level validation errors without retrying", async () => {
    const fieldErrors = [{ fieldPath: "skus[0].stock", message: "stock invalid" }];
    const deps = dependencies({ kind: "validation_failed", fieldErrors });

    await expect(createMiaoshouEditHandler(deps)(job(), execution())).rejects.toMatchObject({
      code: "miaoshou_validation_failed"
    });

    expect(deps.repository.saveValidationFailure).toHaveBeenCalledWith("approval-1", fieldErrors, expect.any(Object));
  });

  it("marks a remote-accepted result unknown and requires reconciliation", async () => {
    const deps = dependencies({
      kind: "needs_reconcile",
      remoteTaskId: "remote-task-1",
      failure: { kind: "reconcile_required", code: "timeout", safeMessage: "result unknown" }
    });

    await expect(createMiaoshouEditHandler(deps)(job(), execution())).rejects.toEqual(
      expect.objectContaining<Partial<ExternalResultUnknownError>>({ remoteTaskId: "remote-task-1" })
    );
    expect(deps.repository.saveResultUnknown).toHaveBeenCalledWith("approval-1", expect.objectContaining({ code: "timeout" }), expect.any(Object));
  });

  it("after restart reconciles by canonical detail and never performs a second edit", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "must-not-be-used" });

    await createMiaoshouEditHandler(deps)(job("remote-task-1"), execution());

    expect(deps.edit.applyEdit).not.toHaveBeenCalled();
    expect(deps.staging.stage).not.toHaveBeenCalled();
    expect(deps.edit.reconcileByCanonicalDetailId).toHaveBeenCalledWith({
      canonicalSuccessDetailId: "detail-3799770548",
      sourceItemId: "892408514788"
    });
    expect(deps.repository.saveReconciled).toHaveBeenCalledWith("approval-1", expect.objectContaining({ state: "applied" }), expect.any(Object));
  });

  it.each(["no_change", "missing"] as const)(
    "keeps result unknown when reconciliation returns %s and never performs a second edit",
    async (state) => {
      const deps = dependencies({ kind: "succeeded", remoteDetailId: "must-not-be-used" });
      deps.edit.reconcileByCanonicalDetailId.mockResolvedValue({ remoteDetailId: "detail-3799770548", state });

      await expect(createMiaoshouEditHandler(deps)(job("remote-task-1"), execution())).rejects.toMatchObject({
        remoteTaskId: "remote-task-1"
      });

      expect(deps.edit.applyEdit).not.toHaveBeenCalled();
      expect(deps.repository.saveReconciled).not.toHaveBeenCalled();
      expect(deps.repository.saveResultUnknown).toHaveBeenCalledWith(
        "approval-1",
        expect.objectContaining({ code: `miaoshou_reconcile_${state}` }),
        expect.any(Object)
      );
    }
  );

  it("does not overturn a persisted success when a later best-effort audit fails", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "remote-1" });
    deps.audit.append.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("audit unavailable"));

    await expect(createMiaoshouEditHandler(deps)(job(), execution())).resolves.toEqual({ next: [] });

    expect(deps.repository.saveSucceeded).toHaveBeenCalledTimes(1);
    expect(deps.repository.saveResultUnknown).not.toHaveBeenCalled();
  });

  it("does not persist a marker or write remotely when the pre-call audit fails", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "must-not-be-used" });
    deps.audit.append.mockRejectedValue(new Error("audit unavailable before call"));
    const run = execution();

    await expect(createMiaoshouEditHandler(deps)(job(), run)).rejects.toThrow(/audit unavailable/);

    expect(run.persistRemoteTask).not.toHaveBeenCalled();
    expect(deps.edit.applyEdit).not.toHaveBeenCalled();
    expect(deps.repository.saveSucceeded).not.toHaveBeenCalled();
    expect(deps.repository.saveResultUnknown).not.toHaveBeenCalled();
  });

  it("does not overturn persisted validation errors when a later best-effort audit fails", async () => {
    const deps = dependencies({
      kind: "validation_failed",
      fieldErrors: [{ fieldPath: "title", message: "invalid" }]
    });
    deps.audit.append.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("audit unavailable"));

    await expect(createMiaoshouEditHandler(deps)(job(), execution())).rejects.toMatchObject({
      code: "miaoshou_validation_failed"
    });

    expect(deps.repository.saveValidationFailure).toHaveBeenCalledTimes(1);
    expect(deps.repository.saveResultUnknown).not.toHaveBeenCalled();
  });

  it("does not overturn reconciliation success when its best-effort call audit fails", async () => {
    const deps = dependencies({ kind: "succeeded", remoteDetailId: "must-not-be-used" });
    deps.audit.append.mockRejectedValue(new Error("reconciliation audit unavailable"));

    await expect(createMiaoshouEditHandler(deps)(job("canonical:detail-3799770548"), execution())).resolves.toEqual({ next: [] });

    expect(deps.repository.saveReconciled).toHaveBeenCalledTimes(1);
    expect(deps.repository.saveResultUnknown).not.toHaveBeenCalled();
    expect(deps.audit.append).toHaveBeenCalledTimes(1);
  });
});
