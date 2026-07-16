import type {
  ApprovalSnapshotV1,
  AssetStagingPort,
  IdempotencyKey,
  MiaoshouEditFieldError,
  MiaoshouEditPort
} from "@tk/contracts";
import { mapApprovalSnapshotToMiaoshouEdit, type MiaoshouEditableDetail } from "@tk/adapters";

import {
  ExternalResultUnknownError,
  LeaseLostError,
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
  persistReconciliationContext(context: {
    version: 1;
    approvalSnapshotId: string;
    canonicalSuccessDetailId: string;
    sourceItemId: string;
    orderedRemoteAssetUrls: readonly string[];
    expectedDetail: MiaoshouEditableDetail;
  }, fence: LeaseFence): Promise<boolean>;
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
      try {
        await input.audit.append({
          action: "miaoshou.edit.reconcile.call",
          targetKind: "approval_snapshot",
          targetId: approvalSnapshotId,
          payload: { canonicalSuccessDetailId: snapshot.canonicalSuccessDetailId },
          redacted: true
        });
      } catch {
        // Reconciliation is read-only and the repository's terminal transaction writes
        // its own audit event. Do not turn an already-known remote outcome into failure.
      }
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
        throw new ExternalResultUnknownError(
          job.remoteTaskId,
          "Miaoshou reconciliation was inconclusive; do not edit again"
        );
      }
      requireFencedWrite(await input.repository.saveReconciled(approvalSnapshotId, reconciled, execution.fence));
      return { next: [] };
    }

    let staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
    const reconciliationMarker = `canonical:${snapshot.canonicalSuccessDetailId}`;
    let externalCallStarted = false;
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
      const expectedDetail = mapApprovalSnapshotToMiaoshouEdit(snapshot, orderedRemoteAssetUrls);
      requireFencedWrite(await input.repository.persistReconciliationContext({
        version: 1,
        approvalSnapshotId,
        canonicalSuccessDetailId: String(snapshot.canonicalSuccessDetailId),
        sourceItemId: String(snapshot.sourceItemId),
        orderedRemoteAssetUrls,
        expectedDetail
      }, execution.fence));
      await input.audit.append({
        action: "miaoshou.edit.call",
        targetKind: "approval_snapshot",
        targetId: approvalSnapshotId,
        payload: { imageCount: orderedRemoteAssetUrls.length },
        redacted: true
      });
      // Persist only after the pre-call audit succeeds and before the non-transactional
      // external write. Audit failure therefore remains a safe, marker-free retry.
      await execution.persistRemoteTask(reconciliationMarker);
      externalCallStarted = true;
      const result = await input.edit.applyEdit({
        approvalSnapshot: snapshot,
        orderedRemoteAssetUrls,
        idempotencyKey: `miaoshou-edit:${approvalSnapshotId}` as IdempotencyKey
      });
      execution.assertLease();

      if (result.kind === "succeeded") {
        requireFencedWrite(await input.repository.saveSucceeded(approvalSnapshotId, result.remoteDetailId, execution.fence));
        return { next: [] };
      }

      if (result.kind === "validation_failed") {
        requireFencedWrite(await input.repository.saveValidationFailure(approvalSnapshotId, result.fieldErrors, execution.fence));
        throw new NeedsInputError("miaoshou_validation_failed", "Miaoshou rejected approved fields");
      }

      requireFencedWrite(await input.repository.saveResultUnknown(approvalSnapshotId, result.failure, execution.fence));
      throw new ExternalResultUnknownError(
        result.remoteTaskId ?? reconciliationMarker,
        "Miaoshou edit result is unknown and must be reconciled"
      );
    } catch (error) {
      if (
        error instanceof ExternalResultUnknownError ||
        error instanceof NeedsInputError ||
        error instanceof LeaseLostError ||
        !externalCallStarted
      ) {
        throw error;
      }
      throw new ExternalResultUnknownError(
        reconciliationMarker,
        "Miaoshou edit may have succeeded before the local result was saved"
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
