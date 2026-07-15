import { scoreImage, type ImageSignals } from "@tk/domain/assets/score-image";
import { NeedsInputError, requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export interface ArchivedImageAnalyzer {
  analyze(input: { remoteUrl: string; archived: Record<string, unknown>; position: number }): Promise<ImageSignals>;
}

export function createArchiveAssetsHandler(input: {
  store: { archive(remoteUrl: string): Promise<Record<string, unknown>> };
  analyzer: ArchivedImageAnalyzer;
  repository: { saveArchive(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean> };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const remoteUrls = Array.isArray(job.payload.remoteUrls) ? job.payload.remoteUrls.filter((url): url is string => typeof url === "string") : [];
    const settled = await Promise.allSettled(remoteUrls.map(async (url, position) => {
      await input.audit.append({ action: "asset.archive.call", targetKind: "product_revision", targetId: revisionId, payload: { position }, redacted: true });
      execution.assertLease();
      try {
        const archived = await input.store.archive(url);
        execution.assertLease();
        const scored = scoreImage(await input.analyzer.analyze({ remoteUrl: url, archived, position }));
        await input.audit.append({ action: "asset.archive.result", targetKind: "product_revision", targetId: revisionId, payload: { position, state: "succeeded" }, redacted: true });
        return { ...archived, ...scored };
      } catch (error) {
        try {
          await input.audit.append({ action: "asset.archive.result", targetKind: "product_revision", targetId: revisionId, payload: { position, state: "failed", code: "archive_failed" }, redacted: true });
        } catch {
          // Preserve the archive failure when audit persistence is also unavailable.
        }
        throw error;
      }
    }));
    const assets = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ remoteUrl: remoteUrls[index], reason: "download_failed" }] : []);
    if (assets.length === 0) throw new NeedsInputError("no_usable_product_image", "No product image could be archived");
    const rejected = assets.filter((asset) => asset.rejectionReason !== null);
    const state = failures.length > 0 || rejected.length > 0 ? "partial" : "ready";
    execution.assertLease();
    requireFencedWrite(await input.repository.saveArchive({ revisionId, assets, failures, state }, execution.fence));
    await input.audit.append({ action: "asset.archive.result", targetKind: "product_revision", targetId: revisionId, payload: { archived: assets.length, failed: failures.length }, redacted: true });
    if (rejected.length === assets.length) throw new NeedsInputError("no_usable_product_image", "No product image passed quality checks");
    return { next: [{ kind: "listing_generate", businessKey: `${revisionId}:listing`, payload: { version: 1, revisionId } }] };
  };
}
