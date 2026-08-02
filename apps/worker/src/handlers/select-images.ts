import { selectCanvasInputs, type CanvasCandidate } from "@tk/domain/assets/select-canvas-inputs";
import { requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export type ImageGenerationPath = "canvas" | "headless";

export function createImageSelectHandler(input: {
  repository: {
    loadSelectionInputs(revisionId: string): Promise<{ candidates: CanvasCandidate[]; referenceUrls: string[]; capacity: number }>;
    saveSelection(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
    markReadyForImageGeneration(revisionId: string, fence: LeaseFence): Promise<boolean>;
  };
  imageGenerationPath?: ImageGenerationPath;
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

    // Headless path: mark ready for image generation and return no next job
    // The product-detail command from Task 9 will create the headless batch and planner job
    if (input.imageGenerationPath === "headless") {
      await input.repository.markReadyForImageGeneration(revisionId, execution.fence);
      return { next: [] };
    }

    // Canvas path (default for compatibility): create canvas_generate job
    return { next: [{ kind: "canvas_generate", businessKey: `${revisionId}:canvas`, payload: { version: 1, revisionId }, maxAttempts: 30 }] };
  };
}
