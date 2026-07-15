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

describe("Canvas automation adapter", () => {
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
      return calls.length === 1 ? response(metadata) : response({ task_id: "canvas_task_01" });
    });
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com/", canvasId: "0f91cb2d8f2846c091829af30ea2d18d", workflowName: "TK工作流", fetchImpl, now: () => "2026-07-16T00:00:00.000Z" });
    const capacity = await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: capacity.workflowVersion, imageUrls: ["https://assets.test/product.jpg"], referenceImageUrls: ["https://assets.test/reference.jpg"], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "tiktok" }, idempotencyKey: idempotencyKey("canvas:product_1:revision_1") })).resolves.toEqual({ remoteTaskId: "canvas_task_01", submittedAt: "2026-07-16T00:00:00.000Z" });
    const body = JSON.parse(String(calls[1]?.init?.body));
    expect(body.image_urls).toEqual(["https://assets.test/product.jpg", "https://assets.test/reference.jpg"]);
    expect(body.image_urls).toHaveLength(2);
    expect((calls[1]?.init?.headers as Record<string, string>)["idempotency-key"]).toBe("canvas:product_1:revision_1");
  });

  it.each([0, 10])("rejects %i images outside the observed 1..capacity range", async (count) => {
    const fetchImpl = vi.fn(async () => response(metadata));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl });
    await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: Array.from({ length: count }, (_, i) => `https://assets.test/${i}.jpg`), referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:range:test_1") })).rejects.toMatchObject({ kind: "needs_input", code: "canvas.invalid_image_count" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate or non-public image URLs instead of filling workflow slots", async () => {
    const fetchImpl = vi.fn(async () => response(metadata));
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas.test", canvasId: "canvas", fetchImpl });
    await adapter.readWorkflowCapacity("workflow_1");
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: ["https://assets.test/same.jpg", "https://assets.test/same.jpg"], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:duplicate:test") })).rejects.toMatchObject({ code: "canvas.invalid_image_urls" });
    await expect(adapter.submit({ workflowId: "workflow_1", workflowVersion: 1, imageUrls: ["file:///tmp/private.jpg"], referenceImageUrls: [], promptContext: { sourceLocale: "zh-CN", targetLocale: "th-TH", style: "neutral" }, idempotencyKey: idempotencyKey("canvas:private:test") })).rejects.toMatchObject({ code: "canvas.invalid_image_urls" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns five valid outputs and resolves relative URLs", async () => {
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl: vi.fn(async () => response(fiveResults)) });
    const result = await adapter.fetchOutputs({ remoteTaskId: "canvas_task_01" });
    expect(result.outputs).toHaveLength(5);
    expect(result.outputs[0]?.url).toBe("https://canvas-n8n.ai2hook.com/assets/output/tk-01.png");
  });

  it("preserves 1-4 valid outputs so Core can mark the run partial", async () => {
    const partial = { ...fiveResults, outputs: [...fiveResults.outputs.slice(0, 3), { url: "javascript:bad", width: 0, height: 0, sha256: "bad" }] };
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl: vi.fn(async () => response(partial)) });
    await expect(adapter.fetchOutputs({ remoteTaskId: "canvas_task_partial" })).resolves.toMatchObject({ outputs: expect.arrayContaining([expect.objectContaining({ sha256: "a".repeat(64) })]) });
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
    const adapter = createCanvasAdapter({ baseUrl: "https://canvas-n8n.ai2hook.com", canvasId: "canvas", fetchImpl });
    await expect(adapter.fetchOutputs({ remoteTaskId: "canvas_task_url_only" })).resolves.toEqual({ outputs: [{
      url: "https://canvas-n8n.ai2hook.com/assets/output/url-only.png",
      width: 2,
      height: 3,
      sha256: createHash("sha256").update(png).digest("hex")
    }] });
  });
});
