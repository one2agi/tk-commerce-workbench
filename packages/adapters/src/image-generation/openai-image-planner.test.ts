import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiImagePlanner } from "./openai-image-planner.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 });
}

// Sequence fetch helper: returns responses in order, or falls back to last response
function sequenceFetch(responses: Response[]): any {
  let callIndex = 0;
  return vi.fn(async () => {
    const response = callIndex < responses.length ? responses[callIndex] : responses[responses.length - 1];
    callIndex += 1;
    return response as Response;
  });
}

function planInput(outputCount: number) {
  return {
    productFacts: {
      title: "红色蝴蝶结发饰",
      category: "accessories",
      attributes: [{ name: "材质", value: "蕾丝" }]
    },
    references: [],
    recipe: {
      version: 1 as const,
      inputCount: 3,
      outputCount,
      mustPreserve: ["红色", "蝴蝶结轮廓"],
      visualDirection: "干净的电商摄影，柔和自然光",
      forbidden: ["改变商品颜色", "添加品牌标识"],
      roles: [
        { key: "hero", instruction: "正面主图，完整展示轮廓" },
        { key: "detail", instruction: "展示蕾丝材质细节" }
      ],
      providerParameters: {}
    },
    requestedOutputCount: outputCount,
    idempotencyKey: idempotencyKey("test:image_plan_1")
  };
}

function validPlan(count: number) {
  return {
    prompts: Array.from({ length: count }, (_, i) => ({
      slot: i + 1,
      role: i === 0 ? "hero" : "detail",
      prompt: `Generate image ${i + 1} showing 红色蝴蝶结发饰 accessory`,
      mustPreserve: ["红色蝴蝶结发饰", "accessories"],
      forbidden: ["logo", "watermark"]
    }))
  };
}

describe("OpenAI image prompt planner", () => {
  it("returns structured prompts matching requested count", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(3)) } }] }));
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: fetchImpl as any });
    const result = await planner.plan(planInput(3));
    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0]).toMatchObject({ slot: 1, role: "hero" });
  });

  it("repairs malformed output before returning prompts", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({ choices: [{ message: { content: "not-json" } }] }),
      jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(3)) } }] })
    ]);
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl });
    await expect(planner.plan(planInput(3))).resolves.toMatchObject({ prompts: [{ slot: 1 }, { slot: 2 }, { slot: 3 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps 429 without leaking provider body", async () => {
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: vi.fn(async () => new Response("secret upstream body", { status: 429 })) });
    await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "retryable", code: "image_planner_rate_limited" });
  });

  it("maps 401/403 to fatal configuration failure", async () => {
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "bad-key", model: "gpt-4o", fetchImpl: vi.fn(async () => new Response("{\"error\": \"invalid\"}", { status: 401 })) });
    await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "fatal", code: "image_planner_auth_failed" });
  });

  it("maps timeout to retryable failure", async () => {
    const err = new Error("The user aborted a request.");
    err.name = "AbortError";
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: vi.fn(async () => { throw err; }), timeoutMs: 100 });
    await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "retryable", code: "image_planner_timeout" });
  });

  it("maps 502/503 to retryable failure", async () => {
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: vi.fn(async () => new Response("gateway error", { status: 502 })) });
    await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "retryable", code: "image_planner_retryable" });
  });

  it("rejects repair response that is still invalid JSON", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({ choices: [{ message: { content: "not-json" } }] }),
      jsonResponse({ choices: [{ message: { content: "still-not-json" } }] })
    ]);
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: fetchImpl as any });
    await expect(planner.plan(planInput(1))).rejects.toMatchObject({ kind: "retryable", code: "image_planner_retryable" });
  });

  it("sends real local images with complete product facts and category instructions", async () => {
    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
    const directory = await mkdtemp(join(tmpdir(), "tk-planner-"));
    const imagePath = join(directory, "source.png");
    await writeFile(imagePath, Buffer.from(validPngBase64, "base64"));
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(1)) } }] }));
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: fetchImpl as any });
    try {
      await planner.plan({
        ...planInput(1),
        references: [{ assetId: "asset_1", localPath: imagePath, extension: "png" }]
      });
      const callBody = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      const userContent = callBody.messages[1].content as Array<Record<string, unknown>>;
      expect(userContent[1]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${validPngBase64}`, detail: "low" }
      });
      expect(userContent[0]?.text).toEqual(expect.stringContaining("红色蝴蝶结发饰"));
      expect(userContent[0]?.text).toEqual(expect.stringContaining("干净的电商摄影，柔和自然光"));
      expect(userContent[0]?.text).toEqual(expect.stringContaining("红色, 蝴蝶结轮廓"));
      expect(userContent[0]?.text).toEqual(expect.stringContaining("改变商品颜色, 添加品牌标识"));
      expect(userContent[0]?.text).toEqual(expect.stringContaining("hero: 正面主图，完整展示轮廓"));
      expect(userContent[0]?.text).toEqual(expect.stringContaining("材质"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops before the LLM call when a selected local reference is invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(1)) } }] }));
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: fetchImpl as any });

    await expect(planner.plan({
      ...planInput(1),
      references: [{ assetId: "asset_missing", localPath: "/missing/product.png", extension: "png" }]
    })).rejects.toMatchObject({ kind: "needs_input", code: "image_reference_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not include credentials in repair call on schema failure", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ prompts: [{ slot: 1, role: "hero", prompt: "", mustPreserve: [], forbidden: [] }] }) } }] }),
      jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(1)) } }] })
    ]);
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "MY_SECRET_API_KEY", model: "gpt-4o", fetchImpl: fetchImpl as any });
    await planner.plan(planInput(1));
    // Verify the repair call does not contain the API key in body
    const repairCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const repairBody = JSON.parse(repairCall[1].body as string);
    expect(repairBody.messages?.some((m: { role: string; content: string }) => m.content?.includes("MY_SECRET_API_KEY"))).toBe(false);
  });
});
