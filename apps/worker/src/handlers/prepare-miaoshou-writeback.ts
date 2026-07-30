import type {
  ExternalFailure,
  IdempotencyKey,
  MiaoshouSourceCollectResult,
  MiaoshouSourcePort
} from "@tk/contracts";

import {
  LeaseLostError,
  NeedsInputError,
  RetryableJobError,
  type LeaseFence,
  type WorkerHandler
} from "../runtime/worker-loop.js";

const MIAOSHOU_DETAIL_PENDING_RETRY_MS = 10_000;

export function createPrepareMiaoshouWritebackHandler(input: {
  port: MiaoshouSourcePort;
  repository: {
    bindCanonicalAndEnqueueEdit(
      value: {
        approvalSnapshotId: string;
        productId: string;
        result: MiaoshouSourceCollectResult;
      },
      fence: LeaseFence
    ): Promise<boolean>;
  };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const payload = requirePayload(job.payload);
    await input.audit.append({
      action: "miaoshou.prepare_writeback.call",
      targetKind: "approval_snapshot",
      targetId: payload.approvalSnapshotId,
      payload: { source: "1688" },
      redacted: true
    });
    execution.assertLease();
    let result: MiaoshouSourceCollectResult;
    try {
      result = await input.port.fetchItem({
        sourceUrl: payload.sourceUrl,
        idempotencyKey: payload.idempotencyKey
      });
    } catch (error) {
      if (isExternalFailure(error)
        && error.kind === "retryable"
        && error.code === "miaoshou.detail_pending") {
        throw new RetryableJobError(
          error.code,
          error.safeMessage,
          MIAOSHOU_DETAIL_PENDING_RETRY_MS
        );
      }
      throw new NeedsInputError(
        "reconcile_required",
        "Miaoshou import result is unknown; review the collect box before trying again"
      );
    }
    execution.assertLease();
    const saved = await input.repository.bindCanonicalAndEnqueueEdit({
      approvalSnapshotId: payload.approvalSnapshotId,
      productId: payload.productId,
      result
    }, execution.fence);
    if (!saved) throw new LeaseLostError();
    await input.audit.append({
      action: "miaoshou.prepare_writeback.result",
      targetKind: "approval_snapshot",
      targetId: payload.approvalSnapshotId,
      payload: {
        state: "ready_for_edit",
        canonicalSuccessDetailId: result.canonicalSuccessDetailId
      },
      redacted: true
    }).catch(() => undefined);
    return { next: [] };
  };
}

function requirePayload(payload: Record<string, unknown>): {
  approvalSnapshotId: string;
  productId: string;
  sourceUrl: string;
  idempotencyKey: IdempotencyKey;
} {
  const approvalSnapshotId = typeof payload.approvalSnapshotId === "string"
    ? payload.approvalSnapshotId.trim()
    : "";
  const productId = typeof payload.productId === "string" ? payload.productId.trim() : "";
  const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl.trim() : "";
  const idempotencyKey = typeof payload.idempotencyKey === "string"
    ? payload.idempotencyKey.trim()
    : "";
  let validUrl = false;
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    validUrl = hostname === "1688.com" || hostname.endsWith(".1688.com");
  } catch {
    validUrl = false;
  }
  if (payload.version !== 1 || !approvalSnapshotId || !productId || !validUrl || !idempotencyKey) {
    throw new NeedsInputError(
      "invalid_miaoshou_prepare_payload",
      "Miaoshou writeback preparation is incomplete or invalid"
    );
  }
  return {
    approvalSnapshotId,
    productId,
    sourceUrl,
    idempotencyKey: idempotencyKey as IdempotencyKey
  };
}

function isExternalFailure(value: unknown): value is ExternalFailure {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["retryable", "needs_input", "reconcile_required", "fatal"].includes(String(candidate.kind))
    && typeof candidate.code === "string"
    && typeof candidate.safeMessage === "string";
}
