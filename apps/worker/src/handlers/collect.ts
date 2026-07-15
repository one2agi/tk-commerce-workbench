import type { IdempotencyKey, MiaoshouSourcePort } from "@tk/contracts";
import { NeedsInputError, type WorkerHandler } from "../runtime/worker-loop.js";

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

export function createCollectHandler(input: {
  port: MiaoshouSourcePort;
  repository: { saveCollected(value: Record<string, unknown>): Promise<{ revisionId: string }> };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job) => {
    const { sourceUrl, batchId, idempotencyKey } = requireCollectPayload(job.payload);
    await input.audit.append({ action: "miaoshou.collect.call", targetKind: "source_batch", targetId: batchId, payload: { source: "1688" }, redacted: true });
    let result;
    try {
      result = await input.port.fetchItem({ sourceUrl, idempotencyKey });
    } catch (error) {
      try {
        await input.audit.append({
          action: "miaoshou.collect.result",
          targetKind: "source_batch",
          targetId: batchId,
          payload: { state: "failed", code: "external_request_failed" },
          redacted: true
        });
      } catch {
        // The original external failure remains the business-visible outcome.
      }
      throw error;
    }
    const created = await input.repository.saveCollected({ batchId, sourceUrl, result });
    await input.audit.append({ action: "miaoshou.collect.result", targetKind: "product_revision", targetId: created.revisionId, payload: { batchId, canonicalSuccessDetailId: result.canonicalSuccessDetailId }, redacted: true });
    return { next: [] };
  };
}
