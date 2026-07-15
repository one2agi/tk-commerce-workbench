const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const CONTACT = /(?:联系(?:微信|电话|手机)?|微信|威信|vx|v信|手机号|电话)\s*[:：]?\s*[a-zA-Z0-9_-]+/gi;
const WHOLESALE = /(?:厂家直销|一件代发|批发价?|混批|招商加盟)/g;

function dedupeWords(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.filter((word, index) => index === 0 || word !== words[index - 1]).join(" ");
}

export function cleanEvidenceText(value: string): string {
  return dedupeWords(
    value
      .replace(INVISIBLE, "")
      .replace(CONTACT, "")
      .replace(WHOLESALE, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function deterministicListingFallback(input: {
  sourceTitle: string;
  sourceDescription: string;
  sourceAttributes: ReadonlyArray<{ name: string; value: string }>;
  style: string;
}) {
  return {
    title: cleanEvidenceText(input.sourceTitle),
    description: cleanEvidenceText(input.sourceDescription),
    attributes: input.sourceAttributes.map((attribute) => ({
      name: cleanEvidenceText(attribute.name),
      value: cleanEvidenceText(attribute.value)
    })),
    styleApplied: input.style,
    provider: "rules" as const,
    model: null,
    degraded: true,
    fallbackUsed: true,
    warningCodes: ["llm_rule_fallback"]
  };
}
