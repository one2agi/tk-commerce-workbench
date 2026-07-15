import { describe, expect, it, vi } from "vitest";
import type { AssetStagingPort, MiaoshouCollectPayloadV1 } from "@tk/contracts";
import { buildHandlerRegistry, createAtomicStagingPort } from "./main.js";
import type { ClaimedWorkerJob, WorkerExecutionContext } from "./runtime/worker-loop.js";

const execution: WorkerExecutionContext = {
  fence: { jobId: "job-1", owner: "worker-1", leaseToken: "lease-1" },
  signal: new AbortController().signal,
  assertLease: vi.fn(),
  persistRemoteTask: vi.fn(async () => undefined),
  scheduleCompensation: vi.fn(async () => undefined)
};

describe("worker composition", () => {
  it("builds the complete persisted DAG handler registry", () => {
    const registry = buildHandlerRegistry({
      ports: { miaoshou: {} as never, llm: {} as never, exchangeRate: {} as never, canvas: {} as never, staging: {} as never },
      repositories: {
        collect: {} as never, archive: {} as never, listing: {} as never, pricing: {} as never,
        exchangeRate: {} as never, templates: {} as never, images: {} as never, canvas: {} as never,
        finalPreview: {} as never
      },
      store: {} as never,
      quota: {} as never,
      audit: {} as never,
      now: () => new Date("2026-07-16T00:00:00Z"),
      maxCanvasRunsPerDay: 10,
      adapterLimits: {
        miaoshou: { concurrency: 1, minIntervalMs: 0 }, llm: { concurrency: 1, minIntervalMs: 0 },
        exchangeRate: { concurrency: 1, minIntervalMs: 0 }, canvas: { concurrency: 1, minIntervalMs: 0 },
        staging: { concurrency: 1, minIntervalMs: 0 }
      }
    });
    expect(Object.keys(registry)).toEqual(expect.arrayContaining([
      "miaoshou_collect", "asset_archive", "listing_generate", "pricing_calculate", "template_match",
      "image_select", "canvas_generate", "final_preview", "exchange_rate_refresh", "staging_cleanup"
    ]));
  });

  it("atomically compensates earlier staged uploads when a later upload fails", async () => {
    const released: string[][] = [];
    const port: AssetStagingPort = {
      stage: vi.fn(async ({ localAssetIds }) => {
        if (localAssetIds[0] === "bad") throw new Error("upload failed");
        return [{ remoteUrl: `https://staging.test/${localAssetIds[0]}`, expiresAt: "2026-07-16T01:00:00Z" }];
      }),
      release: vi.fn(async ({ remoteUrls }) => { released.push(remoteUrls); })
    };
    const atomic = createAtomicStagingPort(port, async (operation) => operation());
    await expect(atomic.stage({ localAssetIds: ["good", "bad"], purpose: "canvas" })).rejects.toThrow("upload failed");
    expect(released).toEqual([["https://staging.test/good"]]);
  });

  it("accepts the frozen typed collection producer payload at the handler boundary", async () => {
    const payload: MiaoshouCollectPayloadV1 = { version: 1, batchId: "batch-1", sourceUrl: "https://detail.1688.com/offer/1.html", idempotencyKey: "collect-1" };
    const fetchItem = vi.fn(async () => ({ canonicalSuccessDetailId: "detail-1" } as never));
    const registry = buildHandlerRegistry({
      ports: { miaoshou: { fetchItem, resolveCanonicalSuccessDetail: vi.fn() }, llm: {} as never, exchangeRate: {} as never, canvas: {} as never, staging: { stage: vi.fn(), release: vi.fn() } },
      repositories: {
        collect: { saveCollected: vi.fn(async () => ({ revisionId: "rev-1" })) }, archive: {} as never, listing: {} as never, pricing: {} as never,
        exchangeRate: {} as never, templates: {} as never, images: {} as never, canvas: {} as never, finalPreview: {} as never
      },
      store: {} as never, quota: {} as never, audit: { append: vi.fn(async () => undefined) }, now: () => new Date(), maxCanvasRunsPerDay: 1,
      adapterLimits: { miaoshou: { concurrency: 1, minIntervalMs: 0 }, llm: { concurrency: 1, minIntervalMs: 0 }, exchangeRate: { concurrency: 1, minIntervalMs: 0 }, canvas: { concurrency: 1, minIntervalMs: 0 }, staging: { concurrency: 1, minIntervalMs: 0 } }
    });
    const claimed: ClaimedWorkerJob = { jobId: "job-1", kind: "miaoshou_collect", businessKey: "collect-1", payload, leaseToken: "lease-1", remoteTaskId: null };
    await registry.miaoshou_collect!(claimed, execution);
    expect(fetchItem).toHaveBeenCalledWith({ sourceUrl: payload.sourceUrl, idempotencyKey: payload.idempotencyKey });
  });
});
