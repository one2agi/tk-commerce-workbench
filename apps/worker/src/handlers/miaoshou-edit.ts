import type {
  ApprovalSnapshotV1,
  AssetStagingPort,
  IdempotencyKey,
  MiaoshouEditFieldError,
  MiaoshouEditPort
} from "@tk/contracts";

import {
  ExternalResultUnknownError,
  NeedsInputError,
  requireFencedWrite,
  type LeaseFence,
  type WorkerHandler
} from "../runtime/worker-loop.js";

interface MiaoshouEditRepository {
  loadSnapshot(approvalSnapshotId: string): Promise<ApprovalSnapshotV1>;
  saveSucceeded(approvalSnapshotId: string, remoteDetailId: string, fence: LeaseFence): Promise<boolean>;
  saveValidationFailure(
    approvalSnapshotId: string,
    fieldErrors: MiaoshouEditFieldError[],
    fence: LeaseFence
  ): Promise<boolean>;
  saveResultUnknown(
    approvalSnapshotId: string,
    failure: Record<string, unknown>,
    fence: LeaseFence
  ): Promise<boolean>;
  saveReconciled(
    approvalSnapshotId: string,
    result: { remoteDetailId: string; state: "applied" | "no_change" | "missing" },
    fence: LeaseFence
  ): Promise<boolean>;
}

export function createMiaoshouEditHandler(input: {
  edit: MiaoshouEditPort;
  staging: AssetStagingPort;
  repository: MiaoshouEditRepository;
  reachability: { assertReachable(urls: string[]): Promise<void> };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const approvalSnapshotId = String(job.payload.approvalSnapshotId ?? "");
    const snapshot = await input.repository.loadSnapshot(approvalSnapshotId);

    if (job.remoteTaskId) {
      await input.audit.append({
        action: "miaoshou.edit.reconcile.call",
        targetKind: "approval_snapshot",
        targetId: approvalSnapshotId,
        payload: { canonicalSuccessDetailId: snapshot.canonicalSuccessDetailId },
        redacted: true
      });
      execution.assertLease();
      const reconciled = await input.edit.reconcileByCanonicalDetailId({
        canonicalSuccessDetailId: snapshot.canonicalSuccessDetailId,
        sourceItemId: snapshot.sourceItemId
      });
      execution.assertLease();
      if (reconciled.state !== "applied") {
        requireFencedWrite(await input.repository.saveResultUnknown(approvalSnapshotId, {
          kind: "reconcile_required",
          code: `miaoshou_reconcile_${reconciled.state}`,
          safeMessage: "Miaoshou reconciliation did not prove the approved edit was applied"
        }, execution.fence));
        await input.audit.append({
          action: "miaoshou.edit.reconcile.result",
          targetKind: "approval_snapshot",
          targetId: approvalSnapshotId,
          payload: { state: reconciled.state },
          redacted: true
        });
        throw new ExternalResultUnknownError(
          job.remoteTaskId,
          "Miaoshou reconciliation was inconclusive; do not edit again"
        );
      }
      requireFencedWrite(await input.repository.saveReconciled(approvalSnapshotId, reconciled, execution.fence));
      await input.audit.append({
        action: "miaoshou.edit.reconcile.result",
        targetKind: "approval_snapshot",
        targetId: approvalSnapshotId,
        payload: { state: reconciled.state, remoteDetailId: reconciled.remoteDetailId },
        redacted: true
      });
      return { next: [] };
    }

    let staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
    try {
      execution.assertLease();
      staged = await input.staging.stage({
        localAssetIds: [...snapshot.orderedFinalAssetIds],
        purpose: "miaoshou_edit"
      });
      if (staged.length !== snapshot.orderedFinalAssetIds.length) {
        throw new NeedsInputError("miaoshou_staging_incomplete", "Not all approved images could be staged");
      }
      const orderedRemoteAssetUrls = staged.map((asset) => asset.remoteUrl);
      await input.reachability.assertReachable(orderedRemoteAssetUrls);
      execution.assertLease();
      await input.audit.append({
        action: "miaoshou.edit.call",
        targetKind: "approval_snapshot",
        targetId: approvalSnapshotId,
        payload: { imageCount: orderedRemoteAssetUrls.length },
        redacted: true
      });
      const result = await input.edit.applyEdit({
        approvalSnapshot: snapshot,
        orderedRemoteAssetUrls,
        idempotencyKey: `miaoshou-edit:${approvalSnapshotId}` as IdempotencyKey
      });
      execution.assertLease();

      if (result.kind === "succeeded") {
        requireFencedWrite(await input.repository.saveSucceeded(approvalSnapshotId, result.remoteDetailId, execution.fence));
        await input.audit.append({
          action: "miaoshou.edit.result",
          targetKind: "approval_snapshot",
          targetId: approvalSnapshotId,
          payload: { state: "succeeded", remoteDetailId: result.remoteDetailId },
          redacted: true
        });
        return { next: [] };
      }

      if (result.kind === "validation_failed") {
        requireFencedWrite(await input.repository.saveValidationFailure(approvalSnapshotId, result.fieldErrors, execution.fence));
        await input.audit.append({
          action: "miaoshou.edit.result",
          targetKind: "approval_snapshot",
          targetId: approvalSnapshotId,
          payload: { state: "validation_failed", fieldErrors: result.fieldErrors },
          redacted: true
        });
        throw new NeedsInputError("miaoshou_validation_failed", "Miaoshou rejected approved fields");
      }

      requireFencedWrite(await input.repository.saveResultUnknown(approvalSnapshotId, result.failure, execution.fence));
      await input.audit.append({
        action: "miaoshou.edit.result",
        targetKind: "approval_snapshot",
        targetId: approvalSnapshotId,
        payload: { state: "result_unknown", code: result.failure.code },
        redacted: true
      });
      throw new ExternalResultUnknownError(
        result.remoteTaskId ?? `canonical:${snapshot.canonicalSuccessDetailId}`,
        "Miaoshou edit result is unknown and must be reconciled"
      );
    } finally {
      if (staged.length > 0) {
        const remoteUrls = staged.map((asset) => asset.remoteUrl);
        try {
          await input.staging.release({ remoteUrls });
          await input.audit.append({
            action: "miaoshou.edit.staging.release",
            targetKind: "approval_snapshot",
            targetId: approvalSnapshotId,
            payload: { state: "succeeded", imageCount: remoteUrls.length },
            redacted: true
          });
        } catch {
          try {
            await input.audit.append({
              action: "miaoshou.edit.staging.release",
              targetKind: "approval_snapshot",
              targetId: approvalSnapshotId,
              payload: { state: "failed", code: "cleanup_deferred" },
              redacted: true
            });
          } catch {
            // Preserve the primary edit outcome when cleanup audit is unavailable.
          }
        }
      }
    }
  };
}
