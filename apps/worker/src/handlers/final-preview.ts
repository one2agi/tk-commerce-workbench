import { requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export function createFinalPreviewHandler(input: {
  repository: { markReady(value: { revisionId: string; state: "ready" }, fence: LeaseFence): Promise<boolean> };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    execution.assertLease();
    requireFencedWrite(await input.repository.markReady({ revisionId, state: "ready" }, execution.fence));
    return { next: [] };
  };
}
