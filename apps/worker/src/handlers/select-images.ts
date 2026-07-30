import { selectCanvasInputs, type CanvasCandidate } from "@tk/domain/assets/select-canvas-inputs";
import { requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export function createImageSelectHandler(input: {
  repository: {
    loadSelectionInputs(revisionId: string): Promise<{ candidates: CanvasCandidate[]; referenceUrls: string[]; capacity: number }>;
    saveSelection(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
  };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const loaded = await input.repository.loadSelectionInputs(revisionId);
    const selected = selectCanvasInputs(loaded);
    execution.assertLease();
    requireFencedWrite(await input.repository.saveSelection({
      revisionId,
      assetIds: selected.productImages.map((asset) => asset.assetId),
      referenceUrls: selected.referenceUrls,
      totalCount: selected.totalCount
    }, execution.fence));
    return { next: [{ kind: "canvas_generate", businessKey: `${revisionId}:canvas`, payload: { version: 1, revisionId }, maxAttempts: 30 }] };
  };
}
