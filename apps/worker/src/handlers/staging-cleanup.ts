import type { AssetStagingPort } from "@tk/contracts";
import type { WorkerHandler } from "../runtime/worker-loop.js";

export function createStagingCleanupHandler(input: {
  staging: AssetStagingPort;
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const remoteUrls = Array.isArray(job.payload.remoteUrls)
      ? job.payload.remoteUrls.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    execution.assertLease();
    await input.audit.append({ action: "staging.cleanup.call", targetKind: "product_revision", targetId: revisionId, payload: { stagedCount: remoteUrls.length }, redacted: true });
    await input.staging.release({ remoteUrls });
    await input.audit.append({ action: "staging.cleanup.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "succeeded" }, redacted: true });
    return { next: [] };
  };
}
