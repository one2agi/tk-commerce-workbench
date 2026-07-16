import { matchTemplate, type MatchableTemplate } from "@tk/domain/templates/match-template";
import { requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export function createTemplateMatchHandler(input: {
  repository: {
    loadMatchInputs(revisionId: string): Promise<{
      category: string | null;
      templates: Array<MatchableTemplate & {
        version: number;
        referenceAssetIds: string[];
        promptFragment: string;
        targetLocale: string;
        visualStyle: string;
      }>;
      defaultTemplateId: string;
    }>;
    saveMatch(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
  };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const loaded = await input.repository.loadMatchInputs(revisionId);
    const matched = matchTemplate(loaded);
    execution.assertLease();
    requireFencedWrite(await input.repository.saveMatch({
      revisionId,
      templateId: matched.id,
      templateVersion: matched.version,
      referenceAssetIds: matched.referenceAssetIds,
      promptFragment: matched.promptFragment,
      targetLocale: matched.targetLocale,
      visualStyle: matched.visualStyle,
      fallbackUsed: matched.fallbackUsed
    }, execution.fence));
    return { next: [{ kind: "image_select", businessKey: `${revisionId}:images`, payload: { version: 1, revisionId } }] };
  };
}
