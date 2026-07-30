import type { IdempotencyKey } from "@tk/contracts";
import type { LlmPort } from "@tk/contracts";
import { cleanEvidenceText, deterministicListingFallback } from "./rule-fallback.js";

export interface GenerateListingInput {
  sourceLocale: string;
  targetLocale: string;
  style: string;
  evidence: {
    sourceTitle: string;
    sourceDescription: string;
    sourceAttributes: ReadonlyArray<{ name: string; value: string }>;
  };
  idempotencyKey: string;
}

export async function generateListing(input: {
  port: LlmPort;
  input: GenerateListingInput;
}) {
  const evidence = {
    sourceTitle: cleanEvidenceText(input.input.evidence.sourceTitle),
    sourceDescription: cleanEvidenceText(input.input.evidence.sourceDescription),
    sourceAttributes: input.input.evidence.sourceAttributes.map((attribute) => ({
      name: cleanEvidenceText(attribute.name),
      value: cleanEvidenceText(attribute.value)
    }))
  };
  try {
    const output = await input.port.generateListing({
      sourceLocale: input.input.sourceLocale,
      targetLocale: input.input.targetLocale,
      style: input.input.style,
      evidence,
      idempotencyKey: input.input.idempotencyKey as IdempotencyKey
    });
    const evidenceAttributes = new Map(evidence.sourceAttributes.map((item) => [`${item.name}\u0000${item.value}`, item]));
    const attributes = output.translatedAttributes
      .map((item) => ({ name: cleanEvidenceText(item.name), value: cleanEvidenceText(item.value) }))
      .filter((item) => evidenceAttributes.has(`${item.name}\u0000${item.value}`));
    return {
      title: cleanEvidenceText(output.title),
      description: cleanEvidenceText(output.description),
      attributes,
      styleApplied: output.styleApplied,
      provider: "llm" as const,
      model: null,
      degraded: false,
      fallbackUsed: output.fallbackUsed,
      warningCodes: [] as string[]
    };
  } catch {
    return deterministicListingFallback({ ...evidence, style: input.input.style, sourceLocale: input.input.sourceLocale, targetLocale: input.input.targetLocale });
  }
}
