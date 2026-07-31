import { describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiCompatibleImageProvider } from "./openai-compatible-image-provider.js";
import type { ImageGenerationRecipeV1 } from "@tk/contracts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 });
}

function config(fetchImpl: typeof fetch) {
  return {
    baseUrl: "https://image.test/v1",
    apiKey: "test-key",
    model: "Agnes-compatible-model",
    fetchImpl
  };
}

function slotInput(slotKey: string) {
  const recipe: ImageGenerationRecipeV1 = { version: 1 as const, inputCount: 3, outputCount: 4, roles: ["hero", "detail"] };
  return {
    prompt: {
      slot: 1,
      role: "hero",
      prompt: "Generate a hero product shot",
      mustPreserve: ["product name", "category"],
      forbidden: ["logo", "watermark"]
    },
    referenceImagePaths: [],
    parameters: {},
    idempotencyKey: idempotencyKey(slotKey)
  };
}

describe("OpenAI-compatible image provider", () => {
  it("sends one slot with a stable idempotency header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_123", status: "queued" }));
    const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
    await expect(provider.submit(slotInput("slot-key-1"))).resolves.toEqual({ kind: "accepted", remoteTaskId: "task_123" });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]?.headers).toMatchObject({ "Idempotency-Key": "slot-key-1" });
  });

  it("accepts a synchronous Agnes image URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ url: "https://cdn.test/result.png" }] }));
    const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
    await expect(provider.submit(slotInput("slot-key-2"))).resolves.toEqual({ kind: "completed", outputUrl: "https://cdn.test/result.png" });
  });

  it("returns pending without resubmitting", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_123", status: "processing" }));
    const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
    await expect(provider.fetch({ remoteTaskId: "task_123" })).resolves.toEqual({ state: "pending" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies a lost submit response as result unknown", async () => {
    const provider = createOpenAiCompatibleImageProvider(config(async () => { throw new TypeError("fetch failed"); }));
    await expect(provider.submit(slotInput("slot-key-3"))).rejects.toMatchObject({ kind: "reconcile_required", code: "image_submission_result_unknown" });
  });
});
