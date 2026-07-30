import { describe, expect, it, vi } from "vitest";
import { createAssetStagingAdapter } from "./asset-staging-adapter.js";

describe("asset staging adapter", () => {
  it.each([408, 425])("classifies transient HTTP %i as retryable", async (status) => {
    const adapter = createAssetStagingAdapter({
      uploadUrl: "https://canvas.test/api/automation/upload",
      resolveLocalAsset: vi.fn(async () => ({
        bytes: new Uint8Array([1]),
        fileName: "a.png",
        contentType: "image/png" as const
      })),
      fetchImpl: vi.fn(async () => new Response(null, { status }))
    });
    await expect(adapter.stage({ localAssetIds: ["a"], purpose: "canvas" })).rejects.toMatchObject({
      kind: "retryable",
      code: `staging.http_${status}`
    });
  });

  it("preserves input order while uploading assets", async () => {
    const adapter = createAssetStagingAdapter({
      uploadUrl: "https://canvas.test/api/automation/upload",
      resolveLocalAsset: async (id) => ({ bytes: new TextEncoder().encode(id), fileName: `${id}.png`, contentType: "image/png" }),
      fetchImpl: vi.fn(async (_url, init) => {
        const body = new TextDecoder().decode(new Uint8Array(init?.body as ArrayBuffer));
        const name = /filename="([^"]+)"/.exec(body)?.[1] ?? "";
        return new Response(JSON.stringify({ url: `https://canvas.test/uploads/${encodeURIComponent(name)}` }), { status: 200 });
      }),
      ttlMs: 3_600_000,
      nowMs: () => Date.parse("2026-07-16T00:00:00.000Z")
    });
    const result = await adapter.stage({ localAssetIds: ["asset 2", "asset/1"], purpose: "canvas" });
    expect(result.map((item) => item.remoteUrl)).toEqual([
      "https://canvas.test/uploads/asset%202.png",
      "https://canvas.test/uploads/asset%2F1.png"
    ]);
    expect(result[0]?.expiresAt).toBe("2026-07-16T01:00:00.000Z");
  });

  it("rejects empty or duplicate local asset ids instead of making a business selection", async () => {
    const adapter = createAssetStagingAdapter({ uploadUrl: "https://canvas.test/api/automation/upload", resolveLocalAsset: vi.fn(), fetchImpl: vi.fn() });
    await expect(adapter.stage({ localAssetIds: ["same", "same"], purpose: "canvas" })).rejects.toMatchObject({ kind: "needs_input", code: "staging.invalid_asset_ids" });
  });

  it("uploads each local asset as multipart to Canvas and returns the remote public URL", async () => {
    const resolveLocalAsset = vi.fn(async (id: string) => ({ bytes: new Uint8Array([1, 2, 3]), fileName: `${id}.png`, contentType: "image/png" as const }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String((init?.headers as Record<string, string>)["content-type"])).toMatch(/^multipart\/form-data; boundary=----tk-staging-/);
      const body = new TextDecoder().decode(new Uint8Array(init?.body as ArrayBuffer));
      expect(body).toContain('Content-Disposition: form-data; name="file"; filename="asset-1.png"');
      expect(body).toContain("Content-Type: image/png");
      expect(body).toContain('Content-Disposition: form-data; name="purpose"');
      return new Response(JSON.stringify({ url: "https://canvas.test/uploads/asset-1.png" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = createAssetStagingAdapter({ uploadUrl: "https://canvas.test/api/automation/upload", apiKey: "secret", resolveLocalAsset, fetchImpl, nowMs: () => Date.parse("2026-07-16T00:00:00.000Z") });
    await expect(adapter.stage({ localAssetIds: ["asset-1"], purpose: "canvas" })).resolves.toEqual([{ remoteUrl: "https://canvas.test/uploads/asset-1.png", expiresAt: "2026-07-16T01:00:00.000Z" }]);
    expect(resolveLocalAsset).toHaveBeenCalledWith("asset-1");
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("preserves Canvas internal asset paths returned by local automation upload", async () => {
    const adapter = createAssetStagingAdapter({
      uploadUrl: "http://127.0.0.1:8123/api/automation/upload",
      resolveLocalAsset: vi.fn(async () => ({ bytes: new Uint8Array([1]), fileName: "asset-1.png", contentType: "image/png" as const })),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ url: "/assets/input/automation_1.png" }), { status: 200 })),
      nowMs: () => Date.parse("2026-07-16T00:00:00.000Z")
    });

    await expect(adapter.stage({ localAssetIds: ["asset-1"], purpose: "canvas" })).resolves.toEqual([
      { remoteUrl: "/assets/input/automation_1.png", expiresAt: "2026-07-16T01:00:00.000Z" }
    ]);
  });

  it("absolutizes Canvas internal asset paths returned by remote automation upload", async () => {
    const adapter = createAssetStagingAdapter({
      uploadUrl: "https://canvas.test/api/automation/upload",
      resolveLocalAsset: vi.fn(async () => ({ bytes: new Uint8Array([1]), fileName: "asset-1.png", contentType: "image/png" as const })),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ url: "/assets/input/automation_1.png" }), { status: 200 })),
      nowMs: () => Date.parse("2026-07-16T00:00:00.000Z")
    });

    await expect(adapter.stage({ localAssetIds: ["asset-1"], purpose: "miaoshou_edit" })).resolves.toEqual([
      { remoteUrl: "https://canvas.test/assets/input/automation_1.png", expiresAt: "2026-07-16T01:00:00.000Z" }
    ]);
  });

  it("release only forgets tracked uploads unless an explicit cleanup hook exists", async () => {
    const cleanup = vi.fn(async () => undefined);
    const adapter = createAssetStagingAdapter({ uploadUrl: "https://canvas.test/api/automation/upload", resolveLocalAsset: vi.fn(async () => ({ bytes: new Uint8Array([1]), fileName: "a.png", contentType: "image/png" as const })), fetchImpl: vi.fn(async () => new Response(JSON.stringify({ url: "https://canvas.test/uploads/a.png" }), { status: 200 })), onRelease: cleanup });
    const [staged] = await adapter.stage({ localAssetIds: ["a"], purpose: "canvas" });
    await adapter.release({ remoteUrls: [staged!.remoteUrl, "https://canvas.test/uploads/not-tracked.png"] });
    expect(cleanup).toHaveBeenCalledWith([staged!.remoteUrl]);
  });
});
