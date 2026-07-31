import type {
  ApprovalSnapshotV1,
  AssetStagingPort,
  IdempotencyKey,
  MiaoshouEditFieldError,
  MiaoshouEditPort
} from "@tk/contracts";
import { fingerprintApprovalSnapshot, sha256Text, stableDigest, type MiaoshouEditExpectation } from "@tk/adapters";
import { createMiaoshouReconciliationContext, type MiaoshouReconciliationContext } from "@tk/db";

import {
  ExternalResultUnknownError,
  LeaseLostError,
  NeedsInputError,
  requireFencedWrite,
  type LeaseFence,
  type WorkerHandler
} from "../runtime/worker-loop.js";
import type { StagingCleanupCodec } from "../runtime/staging-cleanup-codec.js";

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
  saveReconciliationResultUnknown(
    approvalSnapshotId: string,
    result: { remoteDetailId: string; state: "no_change" | "missing" },
    fence: LeaseFence
  ): Promise<boolean>;
  saveReconciled(
    approvalSnapshotId: string,
    result: { remoteDetailId: string; state: "applied" | "no_change" | "missing" },
    fence: LeaseFence
  ): Promise<boolean>;
  persistReconciliationContext(context: MiaoshouReconciliationContext, fence: LeaseFence): Promise<boolean>;
}

export function createMiaoshouEditHandler(input: {
  edit: MiaoshouEditPort;
  staging: AssetStagingPort;
  repository: MiaoshouEditRepository;
  reachability: { assertReachable(urls: string[]): Promise<void> };
  cleanupCodec: StagingCleanupCodec;
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const approvalSnapshotId = String(job.payload.approvalSnapshotId ?? "");
    const snapshot = await input.repository.loadSnapshot(approvalSnapshotId);
    if (!snapshot.canonicalSuccessDetailId) {
      throw new NeedsInputError(
        "miaoshou_detail_id_missing",
        "Miaoshou writeback must finish the import step before editing"
      );
    }

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
        requireFencedWrite(await input.repository.saveReconciliationResultUnknown(
          approvalSnapshotId,
          { remoteDetailId: reconciled.remoteDetailId, state: reconciled.state },
          execution.fence
        ));
        throw new ExternalResultUnknownError(
          job.remoteTaskId,
          "Miaoshou reconciliation was inconclusive; do not edit again"
        );
      }
      requireFencedWrite(await input.repository.saveReconciled(approvalSnapshotId, reconciled, execution.fence));
      return { next: [] };
    }

    let staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
    let reconciliationMarker = `canonical:${snapshot.canonicalSuccessDetailId}`;
    let externalCallStarted = false;
    try {
      execution.assertLease();
      const localAssetIds = snapshot.orderedFinalAssetLocalPaths ?? [];
      if (localAssetIds.length !== snapshot.orderedFinalAssetIds.length) {
        throw new NeedsInputError("miaoshou_asset_paths_missing", "Approved images are missing local archive paths");
      }
      staged = await input.staging.stage({
        localAssetIds,
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
      const orderedRemoteAssetUrlSha256 = orderedRemoteAssetUrls.map(sha256Text);
      const context = createMiaoshouReconciliationContext({
        jobId: execution.fence.jobId,
        approvalSnapshotId,
        canonicalSuccessDetailId: String(snapshot.canonicalSuccessDetailId),
        sourceItemId: String(snapshot.sourceItemId),
        approvalSnapshotDigest: stableDigest(snapshot),
        orderedRemoteAssetUrlSha256,
        expectedDetail: fingerprintApprovalSnapshot(snapshot, orderedRemoteAssetUrlSha256) as MiaoshouEditExpectation
      });
      requireFencedWrite(await input.repository.persistReconciliationContext(context, execution.fence));
      reconciliationMarker = `canonical:${snapshot.canonicalSuccessDetailId}:ctx:${context.contextDigest}`;
      // Persist only after the pre-call audit succeeds and before the non-transactional
      // external write. Audit failure therefore remains a safe, marker-free retry.
      await execution.persistRemoteTask(reconciliationMarker);
      externalCallStarted = true;
      const result = await input.edit.applyEdit({
        approvalSnapshot: snapshot,
        orderedRemoteAssetUrls,
        idempotencyKey: job.businessKey as IdempotencyKey
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
        let released = false;
        try {
          await input.staging.release({ remoteUrls });
          released = true;
          await input.audit.append({
            action: "miaoshou.edit.staging.release_best_effort",
            targetKind: "approval_snapshot",
            targetId: approvalSnapshotId,
            payload: { state: "local_tracking_cleared", remoteDeleteVerified: false, imageCount: remoteUrls.length },
            redacted: true
          });
        } catch {
          if (!released) {
            await execution.scheduleCompensation({
              kind: "staging_cleanup",
              businessKey: `miaoshou-edit:${approvalSnapshotId}:staging-cleanup`,
              payload: {
                version: 1,
                revisionId: String(snapshot.revisionId),
                  protectedRemoteUrls: input.cleanupCodec.protect({
                    remoteUrls,
                    expiresAt: staged.map((asset) => asset.expiresAt).sort()[0]!
                  })
              },
              delayMs: 60_000
            });
          }
          try {
            await input.audit.append({
              action: "miaoshou.edit.staging.release_best_effort",
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
