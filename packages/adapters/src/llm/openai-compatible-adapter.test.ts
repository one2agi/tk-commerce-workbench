import { describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";

function llmResponse(output: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
}

const input = {
  sourceLocale: "zh-CN",
  targetLocale: "zh-CN",
  style: "neutral",
  evidence: { sourceTitle: "男士宽松短裤", sourceDescription: "轻薄舒适", sourceAttributes: [{ name: "颜色", value: "黑色" }] },
  idempotencyKey: idempotencyKey("llm:product_1:revision_1")
};

function groundedOutput(overrides: Record<string, unknown> = {}) {
  return {
    title: "男士宽松短裤",
    description: "轻薄舒适",
    translatedAttributes: [{ name: "颜色", value: "黑色" }],
    styleApplied: "neutral",
    fallbackUsed: false,
    evidenceMappings: [
      { outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "男士宽松短裤" },
      { outputPath: "description", sourcePath: "sourceDescription", sourceQuote: "轻薄舒适" },
      { outputPath: "translatedAttributes.0.name", sourcePath: "sourceAttributes.0.name", sourceQuote: "颜色" },
      { outputPath: "translatedAttributes.0.value", sourcePath: "sourceAttributes.0.value", sourceQuote: "黑色" }
    ],
    ...overrides
  };
}

describe("OpenAI-compatible listing adapter", () => {
  it.each([408, 425])("classifies transient HTTP %i as retryable", async (status) => {
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "https://llm.test/v1",
      apiKey: "secret",
      model: "model-1",
      fetchImpl: vi.fn(async () => new Response(null, { status }))
    });
    await expect(adapter.generateListing(input)).rejects.toMatchObject({
      kind: "retryable",
      code: `llm.http_${status}`
    });
  });

  it("returns grounded structured listing output", async () => {
    const fetchImpl = vi.fn(async () => llmResponse(groundedOutput()));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing(input)).resolves.toMatchObject({ title: "男士宽松短裤", fallbackUsed: false });
    const init = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body)).response_format.type).toBe("json_schema");
    expect(JSON.parse(String(init.body)).response_format.json_schema.schema.required).toContain("evidenceMappings");
  });

  it.each([
    ["material", "100% cotton shorts"],
    ["certification", "CE certified shorts"],
    ["efficacy", "antibacterial and waterproof shorts"],
    ["parameter", "30 cm length shorts"]
  ])("rejects an invented %s claim absent from evidence", async (_kind, title) => {
    const fetchImpl = vi.fn(async () => llmResponse(groundedOutput({ title })));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "TEST_LLM_SECRET_DO_NOT_LOG", model: "model-1", fetchImpl });
    await expect(adapter.generateListing(input)).rejects.toMatchObject({ kind: "fatal", code: "llm.ungrounded_claim" });
  });

  it("allows cross-language listing generation when every output keeps source evidence mappings", async () => {
    const translated = {
      title: "สร้อยคอผู้หญิงจี้โคลเวอร์",
      description: "สแตนเลสไทเทเนียม ไม่ลอกง่าย",
      translatedAttributes: [{ name: "วัสดุ", value: "สแตนเลสไทเทเนียม" }],
      styleApplied: "neutral",
      fallbackUsed: false,
      evidenceMappings: [
        { outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "男士宽松短裤" },
        { outputPath: "description", sourcePath: "sourceDescription", sourceQuote: "轻薄舒适" },
        { outputPath: "translatedAttributes.0.name", sourcePath: "sourceAttributes.0.name", sourceQuote: "颜色" },
        { outputPath: "translatedAttributes.0.value", sourcePath: "sourceAttributes.0.value", sourceQuote: "黑色" }
      ]
    };
    const fetchImpl = vi.fn(async () => llmResponse(translated));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing({ ...input, targetLocale: "th-TH" })).resolves.toMatchObject({
      title: "สร้อยคอผู้หญิงจี้โคลเวอร์",
      fallbackUsed: false
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires an exact source citation for every generated field", async () => {
    const missing = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl: vi.fn(async () => llmResponse({ ...groundedOutput(), evidenceMappings: [{ outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "not in evidence" }] })) });
    await expect(missing.generateListing(input)).rejects.toMatchObject({ code: "llm.ungrounded_claim" });
  });

  it("rejects arbitrary uncited numeric facts without relying on a claim blacklist", async () => {
    const output = groundedOutput({ title: "กางเกงขาสั้น 7 ชิ้น" });
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl: vi.fn(async () => llmResponse(output)) });
    await expect(adapter.generateListing(input)).rejects.toMatchObject({ code: "llm.ungrounded_claim" });
  });

  it.each(["Bamboo", "GOTS certified", "UPF protection", "clinically proven", "anti-aging"])("rejects reviewer bypass claim %s even when it cites an unrelated real source segment", async (claim) => {
    const sameLocaleInput = { ...input, sourceLocale: "en-US", targetLocale: "en-US", evidence: { sourceTitle: "Men's loose shorts", sourceDescription: "Light and comfortable", sourceAttributes: [{ name: "Color", value: "Black" }] } };
    const malicious = {
      title: `Men's loose shorts ${claim}`,
      description: "Light and comfortable",
      translatedAttributes: [{ name: "Color", value: "Black" }],
      styleApplied: "neutral",
      fallbackUsed: false,
      evidenceMappings: [
        { outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "Men's loose shorts" },
        { outputPath: "description", sourcePath: "sourceDescription", sourceQuote: "Light and comfortable" },
        { outputPath: "translatedAttributes.0.name", sourcePath: "sourceAttributes.0.name", sourceQuote: "Color" },
        { outputPath: "translatedAttributes.0.value", sourcePath: "sourceAttributes.0.value", sourceQuote: "Black" }
      ]
    };
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl: vi.fn(async () => llmResponse(malicious)) });
    await expect(adapter.generateListing(sameLocaleInput)).rejects.toMatchObject({ code: "llm.ungrounded_claim" });
  });

  it("still requires exact source citations for cross-language outputs", async () => {
    const fetchImpl = vi.fn(async () => llmResponse({
      ...groundedOutput({ title: "สร้อยคอผู้หญิง" }),
      evidenceMappings: [
        { outputPath: "title", sourcePath: "sourceTitle", sourceQuote: "not in evidence" },
        { outputPath: "description", sourcePath: "sourceDescription", sourceQuote: "轻薄舒适" },
        { outputPath: "translatedAttributes.0.name", sourcePath: "sourceAttributes.0.name", sourceQuote: "颜色" },
        { outputPath: "translatedAttributes.0.value", sourcePath: "sourceAttributes.0.value", sourceQuote: "黑色" }
      ]
    }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing({ ...input, targetLocale: "th-TH" })).rejects.toMatchObject({ code: "llm.ungrounded_claim" });
  });
});
