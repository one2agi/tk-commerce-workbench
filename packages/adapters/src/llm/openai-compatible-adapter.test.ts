import { describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiCompatibleAdapter } from "./openai-compatible-adapter.js";

function llmResponse(output: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
}

const input = {
  sourceLocale: "zh-CN",
  targetLocale: "th-TH",
  style: "neutral",
  evidence: { sourceTitle: "男士宽松短裤", sourceDescription: "轻薄舒适", sourceAttributes: [{ name: "颜色", value: "黑色" }] },
  idempotencyKey: idempotencyKey("llm:product_1:revision_1")
};

describe("OpenAI-compatible listing adapter", () => {
  it("returns grounded structured listing output", async () => {
    const fetchImpl = vi.fn(async () => llmResponse({ title: "กางเกงขาสั้นผู้ชาย", description: "น้ำหนักเบาและสวมใส่สบาย", translatedAttributes: [{ name: "สี", value: "ดำ" }], styleApplied: "neutral", fallbackUsed: false }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing(input)).resolves.toMatchObject({ title: "กางเกงขาสั้นผู้ชาย", fallbackUsed: false });
    const init = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body)).response_format.type).toBe("json_schema");
  });

  it.each([
    ["material", "100% cotton shorts"],
    ["certification", "CE certified shorts"],
    ["efficacy", "antibacterial and waterproof shorts"],
    ["parameter", "30 cm length shorts"]
  ])("rejects an invented %s claim absent from evidence", async (_kind, title) => {
    const fetchImpl = vi.fn(async () => llmResponse({ title, description: "comfortable", translatedAttributes: [], styleApplied: "neutral", fallbackUsed: false }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "TEST_LLM_SECRET_DO_NOT_LOG", model: "model-1", fetchImpl });
    await expect(adapter.generateListing(input)).rejects.toMatchObject({ kind: "fatal", code: "llm.ungrounded_claim" });
  });

  it("rejects an invented Thai material claim absent from Chinese evidence", async () => {
    const fetchImpl = vi.fn(async () => llmResponse({ title: "กางเกงขาสั้นผ้าฝ้าย", description: "ใส่สบาย", translatedAttributes: [], styleApplied: "neutral", fallbackUsed: false }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing(input)).rejects.toMatchObject({ code: "llm.ungrounded_claim" });
  });

  it("allows a Thai translation of a material explicitly present in Chinese evidence", async () => {
    const fetchImpl = vi.fn(async () => llmResponse({ title: "กางเกงขาสั้นผ้าฝ้าย", description: "ใส่สบาย", translatedAttributes: [{ name: "วัสดุ", value: "ผ้าฝ้าย" }], styleApplied: "neutral", fallbackUsed: false }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "model-1", fetchImpl });
    await expect(adapter.generateListing({ ...input, evidence: { ...input.evidence, sourceAttributes: [{ name: "材质", value: "纯棉" }] } })).resolves.toMatchObject({ title: "กางเกงขาสั้นผ้าฝ้าย" });
  });
});
