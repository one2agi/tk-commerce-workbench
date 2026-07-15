import type { LlmPort } from "@tk/contracts";
import { generateListing } from "@tk/domain/listing/generate-listing";
import type { WorkerHandler } from "../runtime/worker-loop.js";

export function createGenerateListingHandler(input: {
  llm: LlmPort;
  repository: {
    loadEvidence(revisionId: string): Promise<{ sourceLocale: string; targetLocale: string; style: string; sourceTitle: string; sourceDescription: string; sourceAttributes: Array<{ name: string; value: string }> }>;
    saveResult(value: Record<string, unknown>): Promise<unknown>;
  };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}): WorkerHandler {
  return async (job) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const evidence = await input.repository.loadEvidence(revisionId);
    await input.audit.append({ action: "listing.generate.call", targetKind: "product_revision", targetId: revisionId, payload: { targetLocale: evidence.targetLocale, style: evidence.style }, redacted: true });
    const result = await generateListing({ port: input.llm, input: {
      sourceLocale: evidence.sourceLocale,
      targetLocale: evidence.targetLocale,
      style: evidence.style,
      evidence: { sourceTitle: evidence.sourceTitle, sourceDescription: evidence.sourceDescription, sourceAttributes: evidence.sourceAttributes },
      idempotencyKey: `listing:${revisionId}`
    } });
    await input.repository.saveResult({ revisionId, ...result });
    await input.audit.append({ action: "listing.generate.result", targetKind: "product_revision", targetId: revisionId, payload: { provider: result.provider, degraded: result.degraded }, redacted: true });
    return { next: [{ kind: "pricing_calculate", businessKey: `${revisionId}:pricing`, payload: { version: 1, revisionId } }] };
  };
}
