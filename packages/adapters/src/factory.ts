import type { AppConfig } from "@tk/config";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AssetStagingPort, CanvasPort, ExchangeRatePort, LlmPort } from "@tk/contracts";
import { createCanvasAdapter } from "./canvas/canvas-adapter.js";
import { createExchangeRateAdapter } from "./exchange-rate/exchange-rate-adapter.js";
import { createEnvAwareFetch } from "./env-aware-fetch.js";
import { createOpenAiCompatibleAdapter } from "./llm/openai-compatible-adapter.js";
import { createSafeImageDownloader } from "./security/safe-image-download.js";
import { createAssetStagingAdapter } from "./staging/asset-staging-adapter.js";
import { createDeterministicAdapterFakes, type AdapterCallCounters } from "./testing/fakes.js";

export interface AdapterBundle {
  readonly mode: "mock" | "live";
  readonly canvas: CanvasPort;
  readonly llm: LlmPort;
  readonly exchangeRate: ExchangeRatePort;
  readonly assetStaging: AssetStagingPort;
  counters(): AdapterCallCounters;
}

export interface LiveCommandContext {
  readonly kind: "worker_command";
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export type AdapterFactoryConfig = Partial<Pick<AppConfig,
  "canvasBaseUrl" | "canvasId" | "canvasWorkflowName" | "canvasApiKey" | "llmBaseUrl" | "llmApiKey" | "llmModel" | "exchangeRateBaseUrl"
>> & Pick<AppConfig, "externalAdapterMode" | "nodeEnv" | "assetRoot"> & {
  readonly processKind?: "app" | "test" | "integration" | "e2e";
};

export interface AdapterFactoryDeps {
  readonly constructLive?: (config: AdapterFactoryConfig, context: LiveCommandContext) => AdapterBundle;
  readonly createLiveFetch?: () => typeof fetch;
}

export function createAdapterBundle(config: AdapterFactoryConfig, commandContext?: LiveCommandContext, deps: AdapterFactoryDeps = {}): AdapterBundle {
  if (config.externalAdapterMode === "mock") {
    const fakes = createDeterministicAdapterFakes();
    return { mode: "mock", canvas: fakes.canvas, llm: fakes.llm, exchangeRate: fakes.exchangeRate, assetStaging: fakes.assetStaging, counters: fakes.counters };
  }
  if (config.nodeEnv === "test" || config.processKind === "test" || config.processKind === "integration" || config.processKind === "e2e") {
    throw new Error("adapter factory: refusing live adapters in test/integration/e2e");
  }
  if (!isStableCommandContext(commandContext)) {
    throw new Error("adapter factory: live mode requires an explicit stable command context");
  }
  if (deps.constructLive) return deps.constructLive(config, commandContext);
  return constructLiveAdapters(config, commandContext, deps.createLiveFetch ?? createEnvAwareFetch);
}

function constructLiveAdapters(config: AdapterFactoryConfig, _context: LiveCommandContext, createLiveFetch: () => typeof fetch): AdapterBundle {
  if (!config.canvasBaseUrl || !config.llmBaseUrl || !config.llmApiKey || !config.llmModel || !config.exchangeRateBaseUrl) {
    throw new Error("adapter factory: live adapter configuration is incomplete");
  }
  const fetchImpl = createLiveFetch();
  return {
    mode: "live",
    canvas: createCanvasAdapter({
      baseUrl: config.canvasBaseUrl,
      apiKey: config.canvasApiKey,
      canvasId: config.canvasId ?? "0f91cb2d8f2846c091829af30ea2d18d",
      workflowName: config.canvasWorkflowName ?? "TK工作流",
      fetchImpl,
      downloadImage: createCanvasOutputDownloader(fetchImpl, config.canvasBaseUrl)
    }),
    llm: createOpenAiCompatibleAdapter({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel, fetchImpl }),
    exchangeRate: createExchangeRateAdapter({ baseUrl: config.exchangeRateBaseUrl, fetchImpl }),
    assetStaging: createAssetStagingAdapter({
      uploadUrl: `${config.canvasBaseUrl.replace(/\/+$/, "")}/api/automation/upload`,
      apiKey: config.canvasApiKey,
      fetchImpl,
      resolveLocalAsset: async (localAssetId) => {
        const root = resolve(config.assetRoot);
        const filePath = resolve(root, localAssetId);
        if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw new Error("asset staging: asset id escapes asset root");
        const extension = extname(filePath).toLowerCase();
        if (extension !== ".png" && extension !== ".jpg" && extension !== ".jpeg") throw new Error("asset staging: unsupported local image type");
        return { bytes: await readFile(filePath), fileName: localAssetId.split(/[\\/]/).at(-1) ?? "asset", contentType: extension === ".png" ? "image/png" : "image/jpeg" };
      }
    }),
    counters: () => Object.freeze({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 })
  };
}

function createCanvasOutputDownloader(fetchImpl: typeof fetch, canvasBaseUrl: string) {
  const fallback = createSafeImageDownloader();
  const baseOrigin = new URL(`${canvasBaseUrl.replace(/\/+$/, "")}/`).origin;
  const maxBytes = 12 * 1024 * 1024;
  return async (value: string): Promise<{ bytes: Uint8Array; finalUrl: string }> => {
    const url = new URL(value);
    if (url.origin !== baseOrigin || !url.pathname.startsWith("/assets/output/")) {
      return fallback(value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "image/png,image/jpeg" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`canvas output download failed with status ${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "image/png" && contentType !== "image/jpeg") {
        throw new Error("canvas output Content-Type must be image/png or image/jpeg");
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error("canvas output response size exceeds limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("canvas output response size exceeds limit");
      return { bytes, finalUrl: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  };
}

export { createEnvAwareFetch } from "./env-aware-fetch.js";

function isStableCommandContext(context: LiveCommandContext | undefined): context is LiveCommandContext {
  return Boolean(context && context.kind === "worker_command" && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,}$/.test(context.commandId) && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,}$/.test(context.idempotencyKey));
}
