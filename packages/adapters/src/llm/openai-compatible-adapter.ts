import { externalFailure, type LlmPort, type LlmStructuredOutputV1 } from "@tk/contracts";

export interface OpenAiCompatibleAdapterConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const CLAIM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["cotton", "纯棉", "棉质", "ผ้าฝ้าย"],
  ["polyester", "聚酯纤维", "โพลีเอสเตอร์"],
  ["leather", "真皮", "หนังแท้"],
  ["silk", "真丝", "丝绸", "ผ้าไหม"],
  ["wool", "羊毛", "ขนสัตว์"],
  ["linen", "亚麻", "ผ้าลินิน"],
  ["nylon", "尼龙", "ไนลอน"],
  ["stainless steel", "不锈钢", "สแตนเลส"],
  ["aluminum", "铝", "อะลูมิเนียม"],
  ["ce certified", "ce认证", "ได้รับการรับรอง ce"],
  ["fda approved", "fda认证", "ผ่านการรับรอง fda"],
  ["iso certified", "iso认证", "ได้รับการรับรอง iso"],
  ["organic certified", "有机认证", "ได้รับการรับรองออร์แกนิก"],
  ["antibacterial", "抗菌", "ต้านแบคทีเรีย"],
  ["waterproof", "防水", "กันน้ำ"],
  ["fireproof", "防火", "กันไฟ"],
  ["cures", "治愈", "รักษาโรค"],
  ["whitening", "美白", "ทำให้ผิวขาว"],
  ["slimming", "瘦身", "ลดความอ้วน"],
  ["medical grade", "医用级", "เกรดทางการแพทย์"]
];
const PARAMETER_PATTERN = /\b\d+(?:\.\d+)?\s*(?:%|cm|mm|kg|g|ml|mah|w|v)\b/gi;

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
              { role: "system", content: "Translate and rewrite only from supplied evidence. Never add material, certification, efficacy, dimensions, quantities, or technical parameters. Return JSON only." },
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
      if (!response.ok) throw externalFailure(response.status >= 500 || response.status === 429 ? "retryable" : "fatal", `llm.http_${response.status}`, "Listing model request failed");
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
      const output = parseListing(candidate, input.style);
      assertGrounded(output, input.evidence);
      return Object.freeze(output);
    }
  };
}

const listingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "translatedAttributes", "styleApplied", "fallbackUsed"],
  properties: {
    title: { type: "string" }, description: { type: "string" },
    translatedAttributes: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
    styleApplied: { type: "string" }, fallbackUsed: { const: false }
  }
} as const;

function parseListing(value: unknown, requestedStyle: string): LlmStructuredOutputV1 {
  if (!value || typeof value !== "object") throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid structured output");
  const item = value as Partial<LlmStructuredOutputV1>;
  const attrs = item.translatedAttributes;
  if (typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" || !Array.isArray(attrs) || attrs.some((attr) => !attr || typeof attr.name !== "string" || typeof attr.value !== "string") || item.fallbackUsed !== false) {
    throw externalFailure("fatal", "llm.invalid_response", "Listing model returned invalid structured output");
  }
  return { title: item.title.trim(), description: item.description.trim(), translatedAttributes: attrs, styleApplied: typeof item.styleApplied === "string" ? item.styleApplied : requestedStyle, fallbackUsed: false };
}

function assertGrounded(output: LlmStructuredOutputV1, evidence: Parameters<LlmPort["generateListing"]>[0]["evidence"]): void {
  const source = `${evidence.sourceTitle} ${evidence.sourceDescription} ${evidence.sourceAttributes.map((attr) => `${attr.name} ${attr.value}`).join(" ")}`.toLowerCase();
  const generated = `${output.title} ${output.description} ${output.translatedAttributes.map((attr) => `${attr.name} ${attr.value}`).join(" ")}`.toLowerCase();
  for (const aliases of CLAIM_GROUPS) {
    if (aliases.some((term) => includesClaim(generated, term)) && !aliases.some((term) => includesClaim(source, term))) {
      throw externalFailure("fatal", "llm.ungrounded_claim", "Listing model introduced a claim absent from source evidence");
    }
  }
  const sourceParameters = new Set(source.match(PARAMETER_PATTERN) ?? []);
  for (const parameter of generated.match(PARAMETER_PATTERN) ?? []) {
    if (!sourceParameters.has(parameter)) throw externalFailure("fatal", "llm.ungrounded_claim", "Listing model introduced a parameter absent from source evidence");
  }
}

function includesClaim(text: string, claim: string): boolean {
  if (/^[a-z0-9 ]+$/i.test(claim)) {
    const escaped = claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  }
  return text.includes(claim);
}
