import type { AssetStagingPort } from "@tk/contracts";
import { NeedsInputError, RetryableJobError, type WorkerHandler } from "../runtime/worker-loop.js";
import type { StagingCleanupCodec } from "../runtime/staging-cleanup-codec.js";

export function createStagingCleanupHandler(input: {
  staging: AssetStagingPort;
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
  codec: StagingCleanupCodec;
  now: () => Date;
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const protectedRemoteUrls = typeof job.payload.protectedRemoteUrls === "string" ? job.payload.protectedRemoteUrls : null;
    if (!protectedRemoteUrls) throw new NeedsInputError("staging_expiry_unknown", "Legacy staging cleanup has no verifiable TTL handle");
    const handle = input.codec.unprotect(protectedRemoteUrls);
    const expiresAt = Date.parse(handle.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new NeedsInputError("staging_expiry_invalid", "Staging cleanup TTL is invalid");
    const remainingMs = expiresAt - input.now().getTime();
    if (remainingMs > 0) throw new RetryableJobError("staging_ttl_active", "Staged URL has not expired", remainingMs);
    execution.assertLease();
    // The current staging provider has upload + TTL but no cross-process delete.
    await input.audit.append({ action: "staging.cleanup.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "expired", stagedCount: handle.remoteUrls.length, expiresAt: handle.expiresAt }, redacted: true });
    return { next: [] };
  };
}
