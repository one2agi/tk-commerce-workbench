import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyKey } from "@tk/contracts";
import { createOpenAiCompatibleImageProvider } from "./openai-compatible-image-provider.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200 });
}

function config(fetchImpl: typeof fetch, timeouts: { connectTimeoutMs?: number; responseTimeoutMs?: number } = {}) {
  return {
    baseUrl: "https://image.test/v1",
    apiKey: "test-key",
    model: "Agnes-compatible-model",
    fetchImpl,
    ...timeouts
  };
}

let fixtureDirectory: string;
let fixtureImagePath: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "tk-provider-fixture-"));
  fixtureImagePath = join(fixtureDirectory, "reference.png");
  await writeFile(fixtureImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function slotInput(slotKey: string) {
  return {
    prompt: {
      slot: 1,
      role: "hero",
      prompt: "Generate a hero product shot",
      mustPreserve: ["product name", "category"],
      forbidden: ["logo", "watermark"]
    },
    references: [{ assetId: "asset_fixture", localPath: fixtureImagePath, extension: "png" as const }],
    parameters: {},
    idempotencyKey: idempotencyKey(slotKey)
  };
}

describe("OpenAI-compatible image provider", () => {
  it("submits APIMart image references and accepts its task id response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 200,
      data: [{ status: "submitted", task_id: "task_apimart_123" }]
    }));
    const provider = createOpenAiCompatibleImageProvider({
      baseUrl: "https://api.apimart.ai/v1/images/generations",
      apiKey: "test-key",
      model: "gpt-image-2",
      fetchImpl
    });

    await expect(provider.submit(slotInput("slot-apimart-submit"))).resolves.toEqual({
      kind: "accepted",
      remoteTaskId: "task_apimart_123"
    });
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(url).toBe("https://api.apimart.ai/v1/images/generations");
    expect(body.image_urls).toHaveLength(1);
    expect(body.image_urls[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("polls the APIMart task endpoint and reads its completed image URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 200,
      data: {
        id: "task_apimart_123",
        status: "completed",
        progress: 100,
        result: { images: [{ url: ["https://upload.apimart.ai/result.png"] }] }
      }
    }));
    const provider = createOpenAiCompatibleImageProvider({
      baseUrl: "https://api.apimart.ai/v1/images/generations",
      apiKey: "test-key",
      model: "gpt-image-2",
      fetchImpl
    });

    await expect(provider.fetch({ remoteTaskId: "task_apimart_123" })).resolves.toEqual({
      state: "succeeded",
      outputUrl: "https://upload.apimart.ai/result.png"
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(
      "https://api.apimart.ai/v1/tasks/task_apimart_123"
    );
  });

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

  it("sends bounded Agnes data URL strings in selected reference order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tk-provider-"));
    const firstPath = join(directory, "first.png");
    const secondPath = join(directory, "second.jpg");
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const secondBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    await writeFile(firstPath, firstBytes);
    await writeFile(secondPath, secondBytes);
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_refs", status: "queued" }));
    const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));

    try {
      await provider.submit({
        ...slotInput("slot-key-refs"),
        references: [
          { assetId: "asset_first", localPath: firstPath, extension: "png" },
          { assetId: "asset_second", localPath: secondPath, extension: "jpg" }
        ]
      });
      const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body.extra_body.image).toEqual([
        `data:image/png;base64,${firstBytes.toString("base64")}`,
        `data:image/jpeg;base64,${secondBytes.toString("base64")}`
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds an unconnected submission at the connection timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
      const provider = createOpenAiCompatibleImageProvider(config(fetchImpl, {
        connectTimeoutMs: 30_000,
        responseTimeoutMs: 30 * 60_000
      }));
      const submission = provider.submit(slotInput("slot-key-connect-timeout"));
      const outcome = submission.then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error })
      );

      while (fetchImpl.mock.calls.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      await vi.advanceTimersByTimeAsync(29_999);
      await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        state: "rejected",
        error: {
          kind: "reconcile_required",
          code: "image_submission_result_unknown"
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a connected response to continue beyond 30 seconds within the response bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve) => {
          setTimeout(() => resolve({ data: [{ url: "https://cdn.test/slow-result.png" }] }), 31_000);
        })
      } as Response));
      const provider = createOpenAiCompatibleImageProvider(config(fetchImpl, {
        connectTimeoutMs: 30_000,
        responseTimeoutMs: 30 * 60_000
      }));
      const submission = provider.submit(slotInput("slot-key-slow-response"));
      const expectation = expect(submission).resolves.toEqual({
        kind: "completed",
        outputUrl: "https://cdn.test/slow-result.png"
      });

      while (fetchImpl.mock.calls.length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));

      await vi.advanceTimersByTimeAsync(31_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns pending without resubmitting", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "task_123", status: "processing" }));
    const provider = createOpenAiCompatibleImageProvider(config(fetchImpl));
    await expect(provider.fetch({ remoteTaskId: "task_123" })).resolves.toEqual({ state: "pending" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a connected polling response with the response timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: () => new Promise(() => undefined)
      } as Response));
      const provider = createOpenAiCompatibleImageProvider(config(fetchImpl, {
        connectTimeoutMs: 30_000,
        responseTimeoutMs: 30 * 60_000
      }));
      const result = provider.fetch({ remoteTaskId: "task_slow_poll" });
      const expectation = expect(result).resolves.toEqual({ state: "pending" });

      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a lost submit response as result unknown", async () => {
    const provider = createOpenAiCompatibleImageProvider(config(async () => { throw new TypeError("fetch failed"); }));
    await expect(provider.submit(slotInput("slot-key-3"))).rejects.toMatchObject({ kind: "reconcile_required", code: "image_submission_result_unknown" });
  });
});
