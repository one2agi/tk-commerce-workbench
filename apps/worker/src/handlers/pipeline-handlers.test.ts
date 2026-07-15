import { describe, expect, it, vi } from "vitest";
import { createFakePorts } from "@tk/contracts/testing";
import { NeedsInputError, type ClaimedWorkerJob, type WorkerExecutionContext, type WorkerHandler } from "../runtime/worker-loop.js";
import { createPricingHandler } from "./calculate-pricing.js";
import { createExchangeRateRefreshHandler } from "./refresh-exchange-rate.js";
import { createCanvasHandler } from "./generate-canvas.js";
import { createArchiveAssetsHandler } from "./archive-assets.js";
import { createCollectHandler } from "./collect.js";
import { createTemplateMatchHandler } from "./match-template.js";
import { createImageSelectHandler } from "./select-images.js";
import { createFinalPreviewHandler } from "./final-preview.js";

const job = (kind: string, payload: Record<string, unknown>, remoteTaskId: string | null = null): ClaimedWorkerJob => ({
  jobId: `job-${kind}`,
  kind,
  payload,
  leaseToken: "lease-1",
  remoteTaskId
});

const execution: WorkerExecutionContext = {
  fence: { jobId: "job-test", owner: "worker-test", leaseToken: "lease-1" },
  signal: new AbortController().signal,
  assertLease: vi.fn(),
  persistRemoteTask: vi.fn(async () => undefined),
  scheduleCompensation: vi.fn(async () => undefined)
};
const invoke = (handler: WorkerHandler, claimed: ClaimedWorkerJob) => handler(claimed, execution);

describe("pricing handler", () => {
  it.each([
    ["weightKg", null, "missing_weight"],
    ["sourceCostCny", null, "missing_source_cost"],
    ["exchangeRate", null, "missing_exchange_rate"]
  ] as const)("pauses with needs_input when %s is absent", async (field, value, code) => {
    const repository = {
      loadInputs: vi.fn(async () => ({
        weightKg: "0.3",
        sourceCostCny: "10.00",
        domesticShippingCny: "2.00",
        crossBorderCostCny: "3.00",
        exchangeRate: "4.80",
        fixedTargetCostThb: "10.00",
        platformFeeRate: "0.05",
        paymentFeeRate: "0.03",
        targetProfitRate: "0.30",
        ending: "9",
        [field]: value
      })),
      saveReady: vi.fn(async () => true)
    };
    const handler = createPricingHandler({ repository });
    await expect(invoke(handler, job("pricing_calculate", { revisionId: "rev-1" }))).rejects.toMatchObject({ code });
    expect(repository.saveReady).not.toHaveBeenCalled();
  });

  it("persists a reproducible ready price and enqueues template matching", async () => {
    const repository = {
      loadInputs: vi.fn(async () => ({
        weightKg: "0.3", sourceCostCny: "10.00", domesticShippingCny: "2.00", crossBorderCostCny: "3.00",
        exchangeRate: "4.80", exchangeRateSnapshotId: "fx-1", fixedTargetCostThb: "10.00",
        platformFeeRate: "0.05", paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9"
      })),
      saveReady: vi.fn(async () => true)
    };
    const result = await invoke(createPricingHandler({ repository }), job("pricing_calculate", { revisionId: "rev-1" }));
    expect(repository.saveReady).toHaveBeenCalledWith(expect.objectContaining({ revisionId: "rev-1", exchangeRateSnapshotId: "fx-1" }), execution.fence);
    expect(result.next[0]).toMatchObject({ kind: "template_match", businessKey: "rev-1:template" });
  });

  it.each([
    ["weightKg", "-1"],
    ["sourceCostCny", "NaN"],
    ["domesticShippingCny", "-0.01"],
    ["crossBorderCostCny", "-1"],
    ["exchangeRate", "0"],
    ["fixedTargetCostThb", "-1"],
    ["platformFeeRate", "1"],
    ["paymentFeeRate", "-0.01"],
    ["targetProfitRate", "1.2"]
  ])("maps invalid %s=%s to stable needs_input", async (field, value) => {
    const repository = {
      loadInputs: vi.fn(async () => ({
        weightKg: "0.3", sourceCostCny: "10.00", domesticShippingCny: "2.00", crossBorderCostCny: "3.00",
        exchangeRate: "4.80", fixedTargetCostThb: "10.00", platformFeeRate: "0.05", paymentFeeRate: "0.03",
        targetProfitRate: "0.30", ending: "9", [field]: value
      })),
      saveReady: vi.fn(async () => true)
    };
    await expect(invoke(createPricingHandler({ repository }), job("pricing_calculate", { revisionId: "rev-1" }))).rejects.toMatchObject({ code: "invalid_pricing_input" });
    expect(repository.saveReady).not.toHaveBeenCalled();
  });
});

describe("exchange-rate refresh", () => {
  it("persists provider provenance and falls back to the latest successful snapshot as stale", async () => {
    const ports = createFakePorts();
    const repository = {
      recordProvider: vi.fn(async () => true),
      latestSuccessful: vi.fn(async () => ({ id: "fx-old", rate: "4.70", source: "provider", observedAt: "2026-07-15T00:00:00Z" })),
      markStale: vi.fn(async () => true)
    };
    const audit = { append: vi.fn() };
    const handler = createExchangeRateRefreshHandler({ port: ports.exchangeRate, repository, audit, now: () => new Date("2026-07-16T00:00:00Z") });
    await invoke(handler, job("exchange_rate_refresh", { base: "CNY", target: "THB" }));
    expect(repository.recordProvider).toHaveBeenCalledWith(expect.objectContaining({ rate: "4.80", source: "provider" }), execution.fence);

    ports.exchangeRate.fetchSnapshot = async () => { throw new Error("outage"); };
    await invoke(handler, job("exchange_rate_refresh", { base: "CNY", target: "THB" }));
    expect(repository.markStale).toHaveBeenCalledWith("fx-old", execution.fence);
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual([
      "exchange_rate.fetch.call",
      "exchange_rate.fetch.result",
      "exchange_rate.fetch.call",
      "exchange_rate.fetch.fallback"
    ]);
  });
});

describe("Canvas handler", () => {
  it("atomically reserves the daily limit before submit and pauses without a paid call when full", async () => {
    const ports = createFakePorts();
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async () => true)
    };
    const quota = { reserve: vi.fn(async () => false) };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, repository, quota, audit, now: () => new Date("2026-07-16T00:00:00Z"), maxRunsPerDay: 1 });
    await expect(invoke(handler, job("canvas_generate", { revisionId: "rev-1" }))).rejects.toBeInstanceOf(NeedsInputError);
    expect(quota.reserve).toHaveBeenCalledOnce();
    expect(ports.canvas.calls.filter((call) => call.method === "submit")).toHaveLength(0);
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual([
      "canvas.capacity.call",
      "canvas.capacity.result",
      "canvas.quota.denied"
    ]);
  });

  it("records a safe capacity failure result after the call audit", async () => {
    const ports = createFakePorts();
    ports.canvas.readWorkflowCapacity = vi.fn(async () => { throw new Error("authorization header leaked by provider"); });
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [], referenceUrls: [], localAssetIds: [], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async () => true)
    };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, repository, quota: { reserve: vi.fn() }, audit, now: () => new Date("2026-07-16T00:00:00Z"), maxRunsPerDay: 10 });
    await expect(invoke(handler, job("canvas_generate", { revisionId: "rev-1" }))).rejects.toThrow("authorization header leaked by provider");
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual(["canvas.capacity.call", "canvas.capacity.result"]);
    expect(audit.append.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { state: "failed", code: "external_request_failed" } });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("authorization header leaked by provider");
  });

  it("fetches a persisted remote task on reconciliation without submitting again", async () => {
    const ports = createFakePorts();
    ports.canvas.outputsResult = { outputs: ports.canvas.outputsResult.outputs.slice(0, 2) };
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [], referenceUrls: [], localAssetIds: [], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 2 })),
      saveOutputs: vi.fn(async () => true)
    };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, repository, quota: { reserve: vi.fn() }, audit, now: () => new Date("2026-07-16T00:00:00Z"), maxRunsPerDay: 10 });
    await invoke(handler, job("canvas_generate", { revisionId: "rev-1" }, "remote-existing"));
    expect(ports.canvas.calls.map((call) => call.method)).toEqual(["fetchOutputs"]);
    expect(repository.saveOutputs).toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }), execution.fence);
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual(["canvas.fetch.call", "canvas.fetch.result"]);
  });

  it("releases staged assets and fails closed when submit may have reached Canvas", async () => {
    const ports = createFakePorts();
    ports.canvas.submit = vi.fn(async () => { throw new Error("connection reset after request body"); });
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async () => true)
    };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, repository, quota: { reserve: vi.fn(async () => true) }, audit, now: () => new Date("2026-07-16T00:00:00Z"), maxRunsPerDay: 10 });

    await expect(invoke(handler, job("canvas_generate", { revisionId: "rev-1" }))).rejects.toMatchObject({ code: "reconcile_required" });
    expect(ports.assetStaging.calls.map((call) => call.method)).toEqual(["stage", "release"]);
    expect(audit.append.mock.calls.map(([event]) => event.action)).toContain("canvas.submit.result");
    expect(audit.append.mock.calls.map(([event]) => event).find((event) => event.action === "canvas.submit.result")).toMatchObject({ payload: { state: "result_unknown" } });
    expect(execution.persistRemoteTask).not.toHaveBeenCalled();
  });
});

describe("Miaoshou collection handler", () => {
  it("rejects incomplete versioned payloads before making an external request", async () => {
    const port = { fetchItem: vi.fn(), resolveCanonicalSuccessDetail: vi.fn() };
    const audit = { append: vi.fn() };
    const handler = createCollectHandler({ port, repository: { saveCollected: vi.fn() }, audit });
    await expect(invoke(handler, job("miaoshou_collect", { version: 1, sourceUrl: "", batchId: "batch-1", idempotencyKey: "key-1" }))).rejects.toMatchObject({ code: "invalid_collect_payload" });
    expect(port.fetchItem).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("audits the call before dispatch and records a safe failure result", async () => {
    const order: string[] = [];
    const port = {
      fetchItem: vi.fn(async () => { order.push("external"); throw new Error("secret raw response body"); }),
      resolveCanonicalSuccessDetail: vi.fn()
    };
    const audit = { append: vi.fn(async (event: Record<string, unknown>) => { order.push(String(event.action)); }) };
    const handler = createCollectHandler({ port, repository: { saveCollected: vi.fn() }, audit });
    await expect(invoke(handler, job("miaoshou_collect", { version: 1, sourceUrl: "https://detail.1688.com/offer/1.html", batchId: "batch-1", idempotencyKey: "key-1" }))).rejects.toMatchObject({ code: "miaoshou_collect_failed" });
    expect(order).toEqual(["miaoshou.collect.call", "external", "miaoshou.collect.result"]);
    expect(audit.append.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { state: "failed", code: "external_request_failed" } });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain("secret raw response body");
  });
});

describe("asset archive handler", () => {
  it("keeps successful assets when another image fails and continues the product", async () => {
    const store = { archive: vi.fn(async (url: string) => {
      if (url.endsWith("bad.jpg")) throw new Error("download failed");
      return { remoteUrl: url, finalUrl: url, sha256: "hash", path: "/asset/hash.jpg", extension: "jpg", bytes: 4 };
    }) };
    const repository = { saveArchive: vi.fn(async () => true) };
    const audit = { append: vi.fn() };
    const result = await invoke(createArchiveAssetsHandler({ store, repository, audit }), job("asset_archive", { revisionId: "rev-1", remoteUrls: ["https://cdn/good.jpg", "https://cdn/bad.jpg"] }));
    expect(repository.saveArchive).toHaveBeenCalledWith(expect.objectContaining({ state: "partial", assets: [expect.objectContaining({ sha256: "hash" })] }), execution.fence);
    expect(result.next[0]?.kind).toBe("listing_generate");
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual([
      "asset.archive.call",
      "asset.archive.call",
      "asset.archive.result",
      "asset.archive.result",
      "asset.archive.result"
    ]);
  });
});

describe("persisted ready-preview DAG nodes", () => {
  it("persists workspace default template fallback before image selection", async () => {
    const repository = {
      loadMatchInputs: vi.fn(async () => ({
        category: "unknown",
        defaultTemplateId: "default",
        templates: [{ id: "default", enabled: true, rules: [] }]
      })),
      saveMatch: vi.fn(async () => true)
    };
    const result = await invoke(createTemplateMatchHandler({ repository }), job("template_match", { revisionId: "rev-1" }));
    expect(repository.saveMatch).toHaveBeenCalledWith(expect.objectContaining({ templateId: "default", fallbackUsed: true }), execution.fence);
    expect(result.next[0]).toMatchObject({ kind: "image_select", businessKey: "rev-1:images" });
  });

  it("persists capacity-aware ordered image selection before Canvas", async () => {
    const repository = {
      loadSelectionInputs: vi.fn(async () => ({
        capacity: 2,
        referenceUrls: ["https://reference.test/a.jpg"],
        candidates: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "hash-a" }]
      })),
      saveSelection: vi.fn(async () => true)
    };
    const result = await invoke(createImageSelectHandler({ repository }), job("image_select", { revisionId: "rev-1" }));
    expect(repository.saveSelection).toHaveBeenCalledWith(expect.objectContaining({ assetIds: ["a"] }), execution.fence);
    expect(result.next[0]).toMatchObject({ kind: "canvas_generate", businessKey: "rev-1:canvas" });
  });

  it("marks final preview ready with a fenced business write", async () => {
    const repository = { markReady: vi.fn(async () => true) };
    const result = await invoke(createFinalPreviewHandler({ repository }), job("final_preview", { revisionId: "rev-1" }));
    expect(repository.markReady).toHaveBeenCalledWith({ revisionId: "rev-1", state: "ready" }, execution.fence);
    expect(result.next).toEqual([]);
  });
});
