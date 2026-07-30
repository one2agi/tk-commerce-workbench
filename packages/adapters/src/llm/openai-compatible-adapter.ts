import { externalFailure, type LlmPort, type LlmStructuredOutputV1 } from "@tk/contracts";
import { isRetryableHttpStatus } from "../http-status.js";

export interface OpenAiCompatibleAdapterConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createOpenAiCompatibleAdapter(config: OpenAiCompatibleAdapterConfig): LlmPort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  return {
    async generateListing(input): Promise<LlmStructuredOutputV1> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, "idempotency-key": String(input.idempotencyKey) },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            messages: [
              { role: "system", content: "Generate marketplace listing fields in targetLocale using only the supplied evidence. Translate when sourceLocale differs from targetLocale. Do not add claims, quantities, certifications, materials, brands, sizes, or benefits absent from evidence. For every output field provide evidenceMappings with its exact sourcePath and exact sourceQuote. Return JSON only." },
              { role: "user", content: JSON.stringify({ sourceLocale: input.sourceLocale, targetLocale: input.targetLocale, style: input.style, evidence: input.evidence }) }
            ],
            response_format: { type: "json_schema", json_schema: { name: "listing_candidate", strict: true, schema: listingSchema } }
          })
        });
      } catch {
        throw externalFailure("retryable", "llm.network", "Listing model is temporarily unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw externalFailure(isRetryableHttpStatus(response.status) ? "retryable" : "fatal", `llm.http_${response.status}`, "Listing model request failed");
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid JSON");
      }
      const content = (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
      if (!content) throw externalFailure("fatal", "llm.invalid_response", "Listing model returned no structured output");
      let candidate: unknown;
      try {
        candidate = JSON.parse(content);
      } catch {
        throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid structured output");
      }
      const parsed = parseListing(candidate, input.style);
      assertGrounded(parsed.output, parsed.evidenceMappings, input.evidence, input.style, input.sourceLocale, input.targetLocale);
      return Object.freeze(parsed.output);
    }
  };
}

const listingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "translatedAttributes", "styleApplied", "fallbackUsed", "evidenceMappings"],
  properties: {
    title: { type: "string" }, description: { type: "string" },
    translatedAttributes: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
    styleApplied: { type: "string" }, fallbackUsed: { const: false },
    evidenceMappings: { type: "array", items: { type: "object", additionalProperties: false, required: ["outputPath", "sourcePath", "sourceQuote"], properties: { outputPath: { type: "string" }, sourcePath: { type: "string" }, sourceQuote: { type: "string" } } } }
  }
} as const;

type EvidenceMapping = { outputPath: string; sourcePath: string; sourceQuote: string };

function parseListing(value: unknown, requestedStyle: string): { output: LlmStructuredOutputV1; evidenceMappings: EvidenceMapping[] } {
  if (!value || typeof value !== "object") throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid structured output");
  const item = value as Partial<LlmStructuredOutputV1> & { evidenceMappings?: EvidenceMapping[] };
  const attrs = item.translatedAttributes;
  if (typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" || !Array.isArray(attrs) || attrs.some((attr) => !attr || typeof attr.name !== "string" || typeof attr.value !== "string") || item.fallbackUsed !== false || !Array.isArray(item.evidenceMappings) || item.evidenceMappings.some((mapping) => !mapping || typeof mapping.outputPath !== "string" || typeof mapping.sourcePath !== "string" || typeof mapping.sourceQuote !== "string")) {
    throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid structured output");
  }
  return { output: { title: item.title.trim(), description: item.description.trim(), translatedAttributes: attrs, styleApplied: typeof item.styleApplied === "string" ? item.styleApplied : requestedStyle, fallbackUsed: false }, evidenceMappings: item.evidenceMappings };
}

function assertGrounded(output: LlmStructuredOutputV1, mappings: EvidenceMapping[], evidence: Parameters<LlmPort["generateListing"]>[0]["evidence"], requestedStyle: string, sourceLocale: string, targetLocale: string): void {
  const sourceByPath = new Map<string, string>([["sourceTitle", evidence.sourceTitle], ["sourceDescription", evidence.sourceDescription]]);
  const outputByPath = new Map<string, string>([["title", output.title], ["description", output.description]]);
  const expectedSourcePath = new Map<string, string>([["title", "sourceTitle"], ["description", "sourceDescription"]]);
  const sameLocale = sourceLocale.toLowerCase() === targetLocale.toLowerCase();
  evidence.sourceAttributes.forEach((attribute, index) => {
    sourceByPath.set(`sourceAttributes.${index}.name`, attribute.name);
    sourceByPath.set(`sourceAttributes.${index}.value`, attribute.value);
  });
  output.translatedAttributes.forEach((attribute, index) => {
    outputByPath.set(`translatedAttributes.${index}.name`, attribute.name);
    outputByPath.set(`translatedAttributes.${index}.value`, attribute.value);
    expectedSourcePath.set(`translatedAttributes.${index}.name`, `sourceAttributes.${index}.name`);
    expectedSourcePath.set(`translatedAttributes.${index}.value`, `sourceAttributes.${index}.value`);
  });
  const mapped = new Set<string>();
  const invalidShape = output.translatedAttributes.length !== evidence.sourceAttributes.length || output.styleApplied !== requestedStyle || mappings.length !== outputByPath.size;
  if (invalidShape) throwUngrounded();
  for (const mapping of mappings) {
    const sourceValue = sourceByPath.get(mapping.sourcePath);
    const outputValue = outputByPath.get(mapping.outputPath);
    if (mapped.has(mapping.outputPath) || expectedSourcePath.get(mapping.outputPath) !== mapping.sourcePath || sourceValue === undefined || outputValue === undefined || mapping.sourceQuote !== sourceValue) throwUngrounded();
    if (sameLocale && outputValue !== sourceValue) throwUngrounded();
    mapped.add(mapping.outputPath);
  }
  if ([...outputByPath.keys()].some((path) => !mapped.has(path))) throwUngrounded();
}

function throwUngrounded(): never {
  throw externalFailure("fatal", "llm.ungrounded_claim", "Listing model introduced content that cannot be proven from source evidence");
}
