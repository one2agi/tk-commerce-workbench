import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "@tk/contracts";
import { createCanvasAdapter } from "./canvas-adapter.js";

const FIXTURES = fileURLToPath(new URL("../../../../tests/fixtures/external/canvas", import.meta.url));
const metadata = JSON.parse(readFileSync(`${FIXTURES}/tk-workflow-metadata.json`, "utf8"));
const fiveResults = JSON.parse(readFileSync(`${FIXTURES}/tk-workflow-five-results.json`, "utf8"));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const downloadedImage = { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3]), finalUrl: "https://canvas-n8n.ai2hook.com/assets/output/final.png" };

describe("Canvas automation adapter", () => {
  it.each([408, 425])("classifies transient HTTP %i as retryable", async (status) => {
    const adapter = createCanvasAdapter({
      baseUrl: "https://canvas.test",
      canvasId: "canvas",
      fetchImpl: vi.fn(async () => response({}, status))
    });
    await expect(adapter.readWorkflowCapacity("workflow_1")).rejects.toMatchObject({
      kind: "retryable",
      code: `canvas.http_${status}`
    });
  });

  it.each([408, 425])("treats HTTP %i from submit as result unknown without issuing a second write", async (status) => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return String(url).endsWith("/workflows") ? response(metadata) : response({}, status);
    });
    const adapter = createCanvasAdapter({
      baseUrl: "https://canvas.test",
      canvasId: "canvas",
      fetchImpl,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }]
    });

    await expect(adapter.submit({
      workflowId: "workflow_1",
      workflowVersion: 1,
      imageUrls: ["https://assets.test/product.jpg"],
      referenceImageUrls: [],
      promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" },
      idempotencyKey: idempotencyKey(`canvas:http-${status}`)
    })).rejects.toMatchObject({
      kind: "reconcile_required",
      code: "canvas.submit_result_unknown"
    });
    expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/automation/workflow-runs"))).toHaveLength(1);
  });

  it("reads live input capacity and expected generator count from workflow metadata", async () => {
    const fetchImpl = vi.fn(async () => response(metadata));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "0f91cb2d8f2846c091829af30ea2d18d", fetchImpl });
    await expect(adapter.readWorkflowCapacity("workflow_1")).resolves.toEqual({ workflowId: "workflow_1", workflowVersion: 1, inputCapacity: 9, expectedOutputCount: 5 });
  });

  it("derives a stable numeric version from topology when the API exposes no version", async () => {
    const withoutVersion = { workflows: metadata.workflows.map(({ workflow_version: _removed, ...workflow }: { workflow_version: number; [key: string]: unknown }) => workflow) };
    const changed = { workflows: withoutVersion.workflows.map((workflow: Record<string, unknown>) => ({ ...workflow, workflow_key: "changed-graph-key" })) };
    const first = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl: vi.fn(async () => response(withoutVersion)) });
    const second = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl: vi.fn(async () => response(changed)) });
    const firstVersion = (await first.readWorkflowCapacity("workflow_1")).workflowVersion;
    const secondVersion = (await second.readWorkflowCapacity("workflow_1")).workflowVersion;
    expect(firstVersion).toBeGreaterThan(0);
    expect(secondVersion).not.toBe(firstVersion);
  });

  it("submits only provided ordered images and never fills unused capacity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length <= 2 ? response(metadata) : response({ task_id: "canvas_task_01" });
    });
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com/", canvasId: "0f91cb2d8f2846c091829af30ea2d18d", workflowName: "TK工作流", fetchImpl, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }], now: () => "2026-07-16T00:00:00.000Z" });
    const capacity = await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: capacity.workflowVersion, imageUrls: ["https://assets.test/product.jpg"], referenceImageUrls: ["https://assets.test/reference.jpg"], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "tiktok" }, idempotencyKey: idempotencyKey("canvas:product_1:revision_1") })).resolves.toEqual({ remoteTaskId: "canvas_task_01", submittedAt: "2026-07-16T00:00:00.000Z" });
    const body = JSON.parse(String(calls[2]?.init?.body));
    expect(body.image_urls).toEqual(["https://assets.test/product.jpg", "https://assets.test/reference.jpg"]);
    expect(body.image_urls).toHaveLength(2);
    expect(body.workflow.prompt_context).toEqual({ source_locale: "zh-CN", target_locale: "th-TH", style: "tiktok" });
    expect(body.llm_user_input).toContain("分析上传商品图片");
    expect((calls[2]?.init?.headers as Record<string, string>)["idempotency-key"]).toBe("canvas:product_1:revision_1");
  });

  it("allows same-origin loopback Canvas asset URLs for local full-live runs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length <= 2 ? response(metadata) : response({ task_id: "local_canvas_task_01" });
    });
    const adapter = createCanvasAdapter({
      baseUrl: "http://127.0.0.1:8123/",
      canvasId: "canvas",
      workflowName: "TK工作流",
      fetchImpl,
      now: () => "2026-07-22T00:00:00.000Z"
    });
    const capacity = await adapter.readWorkflowCapacity("workflow_1");

    await expect(adapter.submit({
      workflowId: "workflow_1",
      workflowVersion: capacity.workflowVersion,
      imageUrls: ["http://127.0.0.1:8123/assets/input/product.jpg"],
      referenceImageUrls: [],
      promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "tiktok" },
      idempotencyKey: idempotencyKey("canvas:loopback-local:test")
    })).resolves.toEqual({
      remoteTaskId: "local_canvas_task_01",
      submittedAt: "2026-07-22T00:00:00.000Z"
    });
    expect(JSON.parse(String(calls[2]?.init?.body)).image_urls).toEqual(["http://127.0.0.1:8123/assets/input/product.jpg"]);
  });

  it("submits Canvas internal asset paths without converting them to loopback URLs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return calls.length <= 2 ? response(metadata) : response({ task_id: "local_canvas_task_02" });
    });
    const adapter = createCanvasAdapter({
      baseUrl: "http://127.0.0.1:8123/",
      canvasId: "canvas",
      workflowName: "TK工作流",
      fetchImpl,
      now: () => "2026-07-22T00:00:00.000Z"
    });
    const capacity = await adapter.readWorkflowCapacity("workflow_1");

    await expect(adapter.submit({
      workflowId: "workflow_1",
      workflowVersion: capacity.workflowVersion,
      imageUrls: ["/assets/input/product.jpg"],
      referenceImageUrls: ["/assets/input/reference.jpg"],
      promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "tiktok" },
      idempotencyKey: idempotencyKey("canvas:internal-path:test")
    })).resolves.toEqual({
      remoteTaskId: "local_canvas_task_02",
      submittedAt: "2026-07-22T00:00:00.000Z"
    });
    expect(JSON.parse(String(calls[2]?.init?.body)).image_urls).toEqual([
      "/assets/input/product.jpg",
      "/assets/input/reference.jpg"
    ]);
  });

  it("reloads workflow capacity and version for every submission", async () => {
    const changed = { workflows: metadata.workflows.map((workflow: Record<string, unknown>) => ({ ...workflow, workflow_version: 2, input_image_count: 1 })) };
    const fetchImpl = vi.fn(async () => fetchImpl.mock.calls.length === 1 ? response(metadata) : response(changed));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl });
    const observed = await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: observed.workflowVersion, imageUrls: ["https://assets.test/a.jpg"], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:refresh:test") })).rejects.toMatchObject({ code: "canvas.workflow_version_changed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([0, 10])("rejects %i images outside the observed 1..capacity range", async (count) => {
    const fetchImpl = vi.fn(async () => response(metadata));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl });
    await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: Array.from({ length: count }, (_, i) => `https://assets.test/${i}.jpg`), referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:range:test_1") })).rejects.toMatchObject({ kind: "needs_input", code: "canvas.invalid_image_count" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate or non-public image URLs instead of filling workflow slots", async () => {
    const fetchImpl = vi.fn(async () => response(metadata));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl });
    await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: ["https://assets.test/same.jpg", "https://assets.test/same.jpg"], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:duplicate:test") })).rejects.toMatchObject({ code: "canvas.invalid_image_urls" });
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: ["file:///tmp/private.jpg"], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:private:test") })).rejects.toMatchObject({ code: "canvas.invalid_image_urls" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["metadata hostname", "http://metadata.google.internal/latest/meta-data", [{ address: "93.184.216.34", family: 4 as const }]],
    ["DNS to private IPv4", "https://private-dns.test/a.jpg", [{ address: "10.0.0.8", family: 4 as const }]],
    ["direct private IPv4", "http://169.254.169.254/latest", [{ address: "93.184.216.34", family: 4 as const }]],
    ["direct private IPv6", "http://[fe80::1]/a.jpg", [{ address: "93.184.216.34", family: 4 as const }]],
    ["DNS to private IPv6", "https://private-v6.test/a.jpg", [{ address: "fc00::1", family: 6 as const }]]
  ])("does not POST workflow-runs when an input URL fails public DNS validation: %s", async (_case, imageUrl, addresses) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => { calls.push(String(url)); return response(metadata); });
    const resolveHost = vi.fn(async () => addresses);
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl, resolveHost });
    const capacity = await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: capacity.workflowVersion, imageUrls: [imageUrl], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:ssrf:input") })).rejects.toMatchObject({ code: "canvas.invalid_image_urls" });
    expect(calls.some((url) => url.endsWith("/api/automation/workflow-runs"))).toBe(false);
  });

  it("returns five valid outputs and resolves relative URLs", async () => {
    const downloadImage = vi.fn(async () => downloadedImage);
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl: vi.fn(async () => response(fiveResults)), downloadImage });
    const result = await adapter.fetchOutputs({ remoteTaskId: "canvas_task_01" });
    expect(result.outputs).toHaveLength(5);
    expect(result.outputs[0]?.url).toBe(downloadedImage.finalUrl);
    expect(result.outputs[0]?.sha256).toBe(createHash("sha256").update(downloadedImage.bytes).digest("hex"));
    expect(downloadImage).toHaveBeenCalledTimes(5);
  });

  it("downloads same-origin loopback Canvas outputs with the adapter fetch implementation", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 2);
    new DataView(png.buffer).setUint32(20, 3);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/automation/workflow-runs/local_task")
      ? response({ status: "succeeded", outputs: ["/assets/output/local.png"] })
      : new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.byteLength) } }));
    const downloadImage = vi.fn(async () => {
      throw new Error("public downloader should not handle same-origin loopback Canvas output");
    });
    const adapter = createCanvasAdapter({ baseUrl: "http://127.0.0.1:8123", canvasId: "canvas", fetchImpl, downloadImage });

    await expect(adapter.fetchOutputs({ remoteTaskId: "local_task" })).resolves.toEqual({
      outputs: [{
        url: "http://127.0.0.1:8123/assets/output/local.png",
        width: 2,
        height: 3,
        sha256: createHash("sha256").update(png).digest("hex")
      }]
    });
    expect(downloadImage).not.toHaveBeenCalled();
  });

  it("accepts local Canvas workflow results returned as images", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 4);
    new DataView(png.buffer).setUint32(20, 5);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/automation/workflow-runs/local_images")
      ? response({ status: "succeeded", images: ["/assets/output/one.png", "/assets/output/two.png"] })
      : new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const adapter = createCanvasAdapter({ baseUrl: "http://127.0.0.1:8123", canvasId: "canvas", fetchImpl });

    await expect(adapter.fetchOutputs({ remoteTaskId: "local_images" })).resolves.toMatchObject({
      outputs: [
        { url: "http://127.0.0.1:8123/assets/output/one.png", width: 4, height: 5 },
        { url: "http://127.0.0.1:8123/assets/output/two.png", width: 4, height: 5 }
      ]
    });
  });

  it("preserves 1-4 valid outputs so Core can mark the run partial", async () => {
    const partial = { ...fiveResults, result: { outputs: [...fiveResults.result.outputs.slice(0, 3), "javascript:bad"] } };
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl: vi.fn(async () => response(partial)), downloadImage: vi.fn(async () => downloadedImage) });
    expect((await adapter.fetchOutputs({ remoteTaskId: "canvas_task_partial" })).outputs).toHaveLength(3);
  });

  it("fails with a stable code when no valid output exists", async () => {
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl: vi.fn(async () => response({ status: "succeeded", outputs: [{ url: "", width: 0, height: 0, sha256: "" }] })) });
    await expect(adapter.fetchOutputs({ remoteTaskId: "canvas_task_empty" })).rejects.toMatchObject({ kind: "fatal", code: "canvas.no_valid_outputs" });
  });

  it("hydrates URL-only API outputs with real file dimensions and content sha256", async () => {
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 2);
    new DataView(png.buffer).setUint32(20, 3);
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => fetchImpl.mock.calls.length === 1
      ? response({ status: "succeeded", outputs: ["/assets/output/url-only.png"] })
      : new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl, downloadImage: async (url) => ({ bytes: png, finalUrl: url }) });
    await expect(adapter.fetchOutputs({ remoteTaskId: "canvas_task_url_only" })).resolves.toEqual({ outputs: [{
      url: "https://canvas-n8n.ai2hook.com/assets/output/url-only.png",
      width: 2,
      height: 3,
      sha256: createHash("sha256").update(png).digest("hex")
    }] });
  });
});
