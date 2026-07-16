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
const cleanupCodec = { protect: vi.fn(() => "protected"), unprotect: vi.fn(() => ({ remoteUrls: [], expiresAt: "2026-07-16T01:00:00Z" })) };

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
  const store = () => ({
    archive: vi.fn(async (remoteUrl: string) => ({
      remoteUrl,
      finalUrl: remoteUrl,
      sha256: `local-${remoteUrl.split("/").at(-1)}`,
      path: `/data/assets/${remoteUrl.split("/").at(-1)}`,
      extension: "png",
      bytes: 16
    }))
  });

  it("atomically reserves the daily limit before submit and pauses without a paid call when full", async () => {
    const ports = createFakePorts();
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async (_value: Record<string, unknown>) => true)
    };
    const quota = { reserve: vi.fn(async () => false) };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: store(), repository, quota, audit, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 1 });
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
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async (_value: Record<string, unknown>) => true)
    };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: store(), repository, quota: { reserve: vi.fn() }, audit, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 10 });
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
    const outputStore = store();
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: outputStore, repository, quota: { reserve: vi.fn() }, audit, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 10 });
    const result = await invoke(handler, job("canvas_generate", { revisionId: "rev-1" }, "remote-existing"));
    expect(ports.canvas.calls.map((call) => call.method)).toEqual(["fetchOutputs"]);
    expect(outputStore.archive).toHaveBeenCalledTimes(2);
    expect(repository.saveOutputs).toHaveBeenCalledWith(expect.objectContaining({
      state: "succeeded",
      assets: [
        expect.objectContaining({ remoteUrl: expect.stringContaining("/0.png"), path: "/data/assets/0.png" }),
        expect.objectContaining({ remoteUrl: expect.stringContaining("/1.png"), path: "/data/assets/1.png" })
      ]
    }), execution.fence);
    expect(result.next).toEqual([{ kind: "final_preview", businessKey: "rev-1:preview", payload: { version: 1, revisionId: "rev-1" } }]);
    expect(audit.append.mock.calls.map(([event]) => event.action)).toEqual(["canvas.fetch.call", "canvas.fetch.result"]);
  });

  it("keeps locally archived Canvas outputs in order and marks a failed sibling partial", async () => {
    const ports = createFakePorts();
    const outputStore = store();
    outputStore.archive.mockImplementation(async (remoteUrl: string) => {
      if (remoteUrl.endsWith("/2.png")) throw new Error("invalid image");
      return { remoteUrl, finalUrl: remoteUrl, sha256: `hash-${remoteUrl.at(-5)}`, path: `/data/${remoteUrl.at(-5)}.png`, extension: "png", bytes: 16 };
    });
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async (_value: Record<string, unknown>) => true)
    };
    const result = await invoke(createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: outputStore, repository, quota: { reserve: vi.fn(async () => true) }, audit: { append: vi.fn() }, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 10 }), job("canvas_generate", { revisionId: "rev-1" }));

    expect(outputStore.archive).toHaveBeenCalledTimes(5);
    expect(repository.saveOutputs).toHaveBeenCalledWith(expect.objectContaining({
      state: "partial",
      assets: expect.arrayContaining([expect.objectContaining({ remoteUrl: expect.stringContaining("/0.png") })])
    }), execution.fence);
    expect(repository.saveOutputs.mock.calls[0]?.[0].assets).toHaveLength(4);
    expect(result.next[0]?.kind).toBe("final_preview");
  });

  it("persists failed Canvas state and stops when no remote output survives local validation", async () => {
    const ports = createFakePorts();
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [], referenceUrls: [], localAssetIds: [], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async () => true)
    };
    const rejectingStore = { archive: vi.fn(async () => { throw new Error("rejected image"); }) };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: rejectingStore, repository, quota: { reserve: vi.fn(async () => true) }, audit: { append: vi.fn() }, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 10 });

    await expect(invoke(handler, job("canvas_generate", { revisionId: "rev-1" }, "remote-existing"))).rejects.toMatchObject({ code: "canvas_zero_valid_outputs" });
    expect(repository.saveOutputs).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", assets: [] }), execution.fence);
  });

  it("releases staged assets and fails closed when submit may have reached Canvas", async () => {
    vi.mocked(execution.persistRemoteTask).mockClear();
    const ports = createFakePorts();
    ports.canvas.submit = vi.fn(async () => { throw new Error("connection reset after request body"); });
    const repository = {
      loadPlan: vi.fn(async () => ({ workflowId: "TKWorkflow", templateVersion: 1, productImages: [{ assetId: "a", url: "local:a", role: "primary" as const, score: 1, perceptualHash: "a" }], referenceUrls: [], localAssetIds: ["a"], sourceLocale: "zh-CN", targetLocale: "th-TH", style: "clean", expectedOutputCount: 5 })),
      saveOutputs: vi.fn(async () => true)
    };
    const audit = { append: vi.fn() };
    const handler = createCanvasHandler({ canvas: ports.canvas, staging: ports.assetStaging, store: store(), repository, quota: { reserve: vi.fn(async () => true) }, audit, now: () => new Date("2026-07-16T00:00:00Z"), cleanupCodec, maxRunsPerDay: 10 });

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
  it("scores analyzer evidence and persists accepted and rejected quality fields", async () => {
    const store = { archive: vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: `hash-${url}`, path: `/asset/${url}.jpg`, extension: "jpg", bytes: 4
    })) };
    const analyzer = { analyze: vi.fn(async ({ remoteUrl }: { remoteUrl: string }) => ({
      width: remoteUrl.includes("small") ? 320 : 1200,
      height: remoteUrl.includes("small") ? 320 : 1200,
      perceptualHash: `phash-${remoteUrl}`,
      clarity: 0.9,
      duplicateDistance: 12,
      watermarkProbability: 0.01,
      collageProbability: 0.02,
      nonProductProbability: 0.03,
      visualScore: 0.88,
      sourceKind: "main" as const
    })) };
    const repository = { saveArchive: vi.fn(async () => true) };
    const audit = { append: vi.fn() };

    await invoke(createArchiveAssetsHandler({ store, analyzer, repository, audit }), job("asset_archive", {
      revisionId: "rev-quality", remoteUrls: ["good", "small"]
    }));

    expect(analyzer.analyze).toHaveBeenCalledTimes(2);
    expect(repository.saveArchive).toHaveBeenCalledWith(expect.objectContaining({
      state: "partial",
      assets: expect.arrayContaining([
        expect.objectContaining({ remoteUrl: "good", width: 1200, height: 1200, perceptualHash: "phash-good", chosenRole: "primary", rejectionReason: null }),
        expect.objectContaining({ remoteUrl: "small", width: 320, height: 320, perceptualHash: "phash-small", rejectionReason: "low_resolution" })
      ])
    }), execution.fence);
  });

  it("keeps successful assets when another image fails and continues the product", async () => {
    const store = { archive: vi.fn(async (url: string) => {
      if (url.endsWith("bad.jpg")) throw new Error("download failed");
      return { remoteUrl: url, finalUrl: url, sha256: "hash", path: "/asset/hash.jpg", extension: "jpg", bytes: 4 };
    }) };
    const analyzer = { analyze: vi.fn(async () => ({
      width: 1200, height: 1200, perceptualHash: "phash", clarity: 1, duplicateDistance: 10,
      watermarkProbability: 0, collageProbability: 0, nonProductProbability: 0, visualScore: 1, sourceKind: "main" as const
    })) };
    const repository = { saveArchive: vi.fn(async () => true) };
    const audit = { append: vi.fn() };
    const result = await invoke(createArchiveAssetsHandler({ store, analyzer, repository, audit }), job("asset_archive", { revisionId: "rev-1", remoteUrls: ["https://cdn/good.jpg", "https://cdn/bad.jpg"] }));
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
        templates: [{ id: "default", version: 7, enabled: true, rules: [] }]
      })),
      saveMatch: vi.fn(async () => true)
    };
    const result = await invoke(createTemplateMatchHandler({ repository }), job("template_match", { revisionId: "rev-1" }));
    expect(repository.saveMatch).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "default",
      templateVersion: 7,
      fallbackUsed: true
    }), execution.fence);
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
