import type { AssetStagingPort, CanvasPort, ExchangeRatePort, LlmPort, MiaoshouSourcePort } from "@tk/contracts";
import { createArchiveAssetsHandler } from "./handlers/archive-assets.js";
import { createPricingHandler } from "./handlers/calculate-pricing.js";
import { createCollectHandler } from "./handlers/collect.js";
import { createFinalPreviewHandler } from "./handlers/final-preview.js";
import { createCanvasHandler } from "./handlers/generate-canvas.js";
import { createGenerateListingHandler } from "./handlers/generate-listing.js";
import { createTemplateMatchHandler } from "./handlers/match-template.js";
import { createExchangeRateRefreshHandler } from "./handlers/refresh-exchange-rate.js";
import { createImageSelectHandler } from "./handlers/select-images.js";
import { createStagingCleanupHandler } from "./handlers/staging-cleanup.js";
import { AdapterLimiterSet, type AdapterLimit } from "./runtime/adapter-limiter.js";
import { runWorkerLoop, type WorkerHandler, type WorkerJobRepository } from "./runtime/worker-loop.js";

export type CoreAdapterName = "miaoshou" | "llm" | "exchangeRate" | "canvas" | "staging";
type LimitedRun = <T>(operation: () => Promise<T>) => Promise<T>;

export function createAtomicStagingPort(port: AssetStagingPort, run: LimitedRun): AssetStagingPort {
  return {
    async stage({ localAssetIds, purpose }) {
      const staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
      try {
        for (const localAssetId of localAssetIds) {
          const one = await run(() => port.stage({ localAssetIds: [localAssetId], purpose }));
          staged.push(...one);
        }
        return staged;
      } catch (error) {
        if (staged.length > 0) await run(() => port.release({ remoteUrls: staged.map((asset) => asset.remoteUrl) })).catch(() => undefined);
        throw error;
      }
    },
    release: (value) => run(() => port.release(value))
  };
}

export interface HandlerRegistryInput {
  ports: {
    miaoshou: MiaoshouSourcePort;
    llm: LlmPort;
    exchangeRate: ExchangeRatePort;
    canvas: CanvasPort;
    staging: AssetStagingPort;
  };
  repositories: {
    collect: Parameters<typeof createCollectHandler>[0]["repository"];
    archive: Parameters<typeof createArchiveAssetsHandler>[0]["repository"];
    listing: Parameters<typeof createGenerateListingHandler>[0]["repository"];
    pricing: Parameters<typeof createPricingHandler>[0]["repository"];
    exchangeRate: Parameters<typeof createExchangeRateRefreshHandler>[0]["repository"];
    templates: Parameters<typeof createTemplateMatchHandler>[0]["repository"];
    images: Parameters<typeof createImageSelectHandler>[0]["repository"];
    canvas: Parameters<typeof createCanvasHandler>[0]["repository"];
    finalPreview: Parameters<typeof createFinalPreviewHandler>[0]["repository"];
  };
  store: Parameters<typeof createArchiveAssetsHandler>[0]["store"];
  quota: Parameters<typeof createCanvasHandler>[0]["quota"];
  audit: Parameters<typeof createCollectHandler>[0]["audit"];
  now: () => Date;
  maxCanvasRunsPerDay: number;
  adapterLimits: Readonly<Record<CoreAdapterName, AdapterLimit>>;
}

export function buildHandlerRegistry(input: HandlerRegistryInput): Readonly<Record<string, WorkerHandler>> {
  const limiters = new AdapterLimiterSet(input.adapterLimits);
  const miaoshou: MiaoshouSourcePort = {
    fetchItem: (value) => limiters.run("miaoshou", () => input.ports.miaoshou.fetchItem(value)),
    resolveCanonicalSuccessDetail: (value) => limiters.run("miaoshou", () => input.ports.miaoshou.resolveCanonicalSuccessDetail(value))
  };
  const llm: LlmPort = { generateListing: (value) => limiters.run("llm", () => input.ports.llm.generateListing(value)) };
  const exchangeRate: ExchangeRatePort = {
    fetchSnapshot: (value) => limiters.run("exchangeRate", () => input.ports.exchangeRate.fetchSnapshot(value)),
    latestSnapshot: (value) => limiters.run("exchangeRate", () => input.ports.exchangeRate.latestSnapshot(value)),
    recordManualOverride: (value) => limiters.run("exchangeRate", () => input.ports.exchangeRate.recordManualOverride(value))
  };
  const canvas: CanvasPort = {
    readWorkflowCapacity: (value) => limiters.run("canvas", () => input.ports.canvas.readWorkflowCapacity(value)),
    submit: (value) => limiters.run("canvas", () => input.ports.canvas.submit(value)),
    fetchOutputs: (value) => limiters.run("canvas", () => input.ports.canvas.fetchOutputs(value))
  };
  const staging = createAtomicStagingPort(input.ports.staging, (operation) => limiters.run("staging", operation));
  return Object.freeze({
    miaoshou_collect: createCollectHandler({ port: miaoshou, repository: input.repositories.collect, audit: input.audit }),
    asset_archive: createArchiveAssetsHandler({ store: input.store, repository: input.repositories.archive, audit: input.audit }),
    listing_generate: createGenerateListingHandler({ llm, repository: input.repositories.listing, audit: input.audit }),
    pricing_calculate: createPricingHandler({ repository: input.repositories.pricing }),
    template_match: createTemplateMatchHandler({ repository: input.repositories.templates }),
    image_select: createImageSelectHandler({ repository: input.repositories.images }),
    canvas_generate: createCanvasHandler({ canvas, staging, repository: input.repositories.canvas, quota: input.quota, audit: input.audit, now: input.now, maxRunsPerDay: input.maxCanvasRunsPerDay }),
    final_preview: createFinalPreviewHandler({ repository: input.repositories.finalPreview }),
    exchange_rate_refresh: createExchangeRateRefreshHandler({ port: exchangeRate, repository: input.repositories.exchangeRate, audit: input.audit, now: input.now }),
    staging_cleanup: createStagingCleanupHandler({ staging, audit: input.audit })
  });
}

export function buildWorkerRuntime(input: HandlerRegistryInput) {
  const handlers = buildHandlerRegistry(input);
  return Object.freeze({
    handlers,
    run(runInput: {
      jobs: WorkerJobRepository;
      workerId: string;
      leaseMs: number;
      workerConcurrency?: number;
      maxJobs?: number;
      clock?: { now(): Date };
    }) {
      return runWorkerLoop({ ...runInput, handlers, clock: runInput.clock ?? { now: input.now } });
    }
  });
}

export async function runWorker(input: {
  jobs: WorkerJobRepository;
  handlers: Readonly<Record<string, WorkerHandler>>;
  workerId: string;
  leaseMs: number;
  workerConcurrency?: number;
  clock?: { now(): Date };
  maxJobs?: number;
}) {
  return runWorkerLoop({ ...input, clock: input.clock ?? { now: () => new Date() } });
}
