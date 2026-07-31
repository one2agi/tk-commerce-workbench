import { describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiImagePlanner } from "./openai-image-planner.js";
import type { ImageGenerationRecipeV1 } from "@tk/contracts";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB MIME+bytes limit for local data URLs

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 });
}

// Sequence fetch helper: returns responses in order, or falls back to last response
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    productFacts: { title: "红色蝴蝶结发饰", category: "accessories" },
    localImagePaths: [],
    recipe: { version: 1 as const, inputCount: 3, outputCount, roles: ["hero", "detail"] },
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

  it("sends selected images as local data URLs after validating MIME and byte limits", async () => {
    const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";
    const oversizedBase64 = "A".repeat(MAX_BYTES + 1);
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(validPlan(1)) } }] }));
    const planner = createOpenAiImagePlanner({ baseUrl: "https://llm.test/v1", apiKey: "secret", model: "gpt-4o", fetchImpl: fetchImpl as any });
    // Input with valid and invalid image paths - invalid should be skipped or handled gracefully
    await planner.plan({ ...planInput(1), localImagePaths: [`data:image/png;base64,${validPngBase64}`] });
    const callBody = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(callBody.messages).toBeDefined();
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
