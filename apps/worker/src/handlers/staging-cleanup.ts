import type { AssetStagingPort } from "@tk/contracts";
import type { WorkerHandler } from "../runtime/worker-loop.js";
import type { StagingCleanupCodec } from "../runtime/staging-cleanup-codec.js";

export function createStagingCleanupHandler(input: {
  staging: AssetStagingPort;
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
  codec: StagingCleanupCodec;
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const protectedRemoteUrls = typeof job.payload.protectedRemoteUrls === "string" ? job.payload.protectedRemoteUrls : null;
    const remoteUrls = protectedRemoteUrls ? input.codec.unprotect(protectedRemoteUrls) : Array.isArray(job.payload.remoteUrls)
      ? job.payload.remoteUrls.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    execution.assertLease();
    await input.audit.append({ action: "staging.cleanup.call", targetKind: "product_revision", targetId: revisionId, payload: { stagedCount: remoteUrls.length }, redacted: true });
    await input.staging.release({ remoteUrls });
    await input.audit.append({ action: "staging.cleanup.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "succeeded" }, redacted: true });
    return { next: [] };
  };
}
