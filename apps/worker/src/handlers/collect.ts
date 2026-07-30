import type { ExternalFailure, IdempotencyKey, MiaoshouSourcePort } from "@tk/contracts";
import { LeaseLostError, NeedsInputError, RetryableJobError, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

const MIAOSHOU_DETAIL_PENDING_RETRY_MS = 10_000;

function requireCollectPayload(payload: Record<string, unknown>): {
  batchId: string;
  sourceUrl: string;
  idempotencyKey: IdempotencyKey;
} {
  const batchId = typeof payload.batchId === "string" ? payload.batchId.trim() : "";
  const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl.trim() : "";
  const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey.trim() : "";
  let protocol = "";
  try {
    protocol = new URL(sourceUrl).protocol;
  } catch {
    // The common validation error below is intentionally safe for the UI.
  }
  if (payload.version !== 1 || !batchId || !sourceUrl || !idempotencyKey || !["http:", "https:"].includes(protocol)) {
    throw new NeedsInputError("invalid_collect_payload", "Collection request is incomplete or invalid");
  }
  return { batchId, sourceUrl, idempotencyKey: idempotencyKey as IdempotencyKey };
}

function isExternalFailure(value: unknown): value is ExternalFailure {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    ["retryable", "needs_input", "reconcile_required", "fatal"].includes(String(candidate.kind)) &&
    typeof candidate.code === "string" &&
    typeof candidate.safeMessage === "string"
  );
}

export function createCollectHandler(input: {
  port: MiaoshouSourcePort;
  repository: { saveCollected(value: Record<string, unknown>, fence: LeaseFence): Promise<{ revisionId: string } | null> };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const { sourceUrl, batchId, idempotencyKey } = requireCollectPayload(job.payload);
    await input.audit.append({ action: "miaoshou.collect.call", targetKind: "source_batch", targetId: batchId, payload: { source: "1688" }, redacted: true });
    execution.assertLease();
    let result;
    try {
      result = await input.port.fetchItem({ sourceUrl, idempotencyKey });
    } catch (error) {
      if (isExternalFailure(error) && error.kind === "retryable" && error.code === "miaoshou.detail_pending") {
        throw new RetryableJobError(error.code, error.safeMessage, MIAOSHOU_DETAIL_PENDING_RETRY_MS);
      }
      try {
        await input.audit.append({
          action: "miaoshou.collect.result",
          targetKind: "source_batch",
          targetId: batchId,
          payload: { state: "result_unknown", code: "reconcile_required" },
          redacted: true
        });
      } catch {
        // The original external failure remains the business-visible outcome.
      }
      throw new NeedsInputError(
        "reconcile_required",
        "Miaoshou collection result is unknown; review the collect box before trying again"
      );
    }
    execution.assertLease();
    const created = await input.repository.saveCollected({ batchId, sourceUrl, result }, execution.fence);
    if (!created) throw new LeaseLostError();
    await input.audit.append({ action: "miaoshou.collect.result", targetKind: "product_revision", targetId: created.revisionId, payload: { batchId, canonicalSuccessDetailId: result.canonicalSuccessDetailId }, redacted: true });
    return { next: [] };
  };
}
