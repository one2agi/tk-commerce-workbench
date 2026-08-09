import type { AppConfig } from "@tk/config";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AssetPublishingPort, AssetStagingPort, CanvasPort, ExchangeRatePort, ImageGenerationPort, ImagePromptPlannerPort, LlmPort } from "@tk/contracts";
import { createCanvasAdapter } from "./canvas/canvas-adapter.js";
import { createExchangeRateAdapter } from "./exchange-rate/exchange-rate-adapter.js";
import { createEnvAwareFetch } from "./env-aware-fetch.js";
import { createOpenAiCompatibleAdapter } from "./llm/openai-compatible-adapter.js";
import { createSafeImageDownloader } from "./security/safe-image-download.js";
import { createAssetStagingAdapter } from "./staging/asset-staging-adapter.js";
import { createOpenAiImagePlanner } from "./image-generation/openai-image-planner.js";
import { createOpenAiCompatibleImageProvider } from "./image-generation/openai-compatible-image-provider.js";
import { createAssetPublishingAdapter } from "./publishing/asset-publishing-adapter.js";
import { createDeterministicAdapterFakes, type AdapterCallCounters } from "./testing/fakes.js";

export interface AdapterBundle {
  readonly mode: "mock" | "live";
  readonly canvas: CanvasPort;
  readonly llm: LlmPort;
  readonly exchangeRate: ExchangeRatePort;
  readonly assetStaging: AssetStagingPort;
  readonly assetPublishing: AssetPublishingPort;
  readonly imagePlanner: ImagePromptPlannerPort;
  readonly imageGeneration: ImageGenerationPort;
  counters(): AdapterCallCounters;
}

export interface LiveCommandContext {
  readonly kind: "worker_command";
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export type AdapterFactoryConfig = Partial<Pick<AppConfig,
  "imageGenerationPath" | "canvasBaseUrl" | "canvasId" | "canvasWorkflowName" | "canvasApiKey" | "llmBaseUrl" | "llmApiKey" | "llmModel" | "exchangeRateBaseUrl" |
  "imagePlannerBaseUrl" | "imagePlannerApiKey" | "imagePlannerModel" |
  "imageProviderBaseUrl" | "imageProviderApiKey" | "imageProviderModel" |
  "assetPublishS3Endpoint" | "assetPublishS3Region" | "assetPublishS3Bucket" | "assetPublishS3AccessKeyId" | "assetPublishS3SecretAccessKey" | "assetPublishPublicBaseUrl"
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
    const publishing = createStubAssetPublishingAdapter();
    return { mode: "mock", canvas: fakes.canvas, llm: fakes.llm, exchangeRate: fakes.exchangeRate, assetStaging: fakes.assetStaging, assetPublishing: publishing, imagePlanner: fakes.imagePlanner, imageGeneration: fakes.imageGeneration, counters: fakes.counters };
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
  const imageGenerationPath = config.imageGenerationPath ?? "canvas";
  if (!config.llmBaseUrl || !config.llmApiKey || !config.llmModel || !config.exchangeRateBaseUrl) {
    throw new Error("adapter factory: live adapter configuration is incomplete");
  }
  if (imageGenerationPath === "canvas" && !config.canvasBaseUrl) {
    throw new Error("adapter factory: live adapter configuration is incomplete");
  }
  if (imageGenerationPath === "headless" && (!config.imagePlannerBaseUrl || !config.imagePlannerApiKey || !config.imagePlannerModel ||
      !config.imageProviderBaseUrl || !config.imageProviderApiKey || !config.imageProviderModel)) {
    throw new Error("adapter factory: live adapter configuration is incomplete");
  }
  const fetchImpl = createLiveFetch();
  const canvasBaseUrl = config.canvasBaseUrl;
  return {
    mode: "live",
    canvas: imageGenerationPath === "canvas" ? createCanvasAdapter({
      baseUrl: canvasBaseUrl!,
      apiKey: config.canvasApiKey,
      canvasId: config.canvasId ?? "0f91cb2d8f2846c091829af30ea2d18d",
      workflowName: config.canvasWorkflowName ?? "TK工作流",
      fetchImpl,
      downloadImage: createCanvasOutputDownloader(fetchImpl, canvasBaseUrl!)
    }) : createInactiveCanvasAdapter(),
    llm: createOpenAiCompatibleAdapter({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel, fetchImpl }),
    exchangeRate: createExchangeRateAdapter({ baseUrl: config.exchangeRateBaseUrl, fetchImpl }),
    assetStaging: imageGenerationPath === "canvas" ? createAssetStagingAdapter({
      uploadUrl: `${canvasBaseUrl!.replace(/\/+$/, "")}/api/automation/upload`,
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
    }) : createInactiveAssetStagingAdapter(),
    imagePlanner: imageGenerationPath === "headless" ? createOpenAiImagePlanner({
      baseUrl: config.imagePlannerBaseUrl!,
      apiKey: config.imagePlannerApiKey!,
      model: config.imagePlannerModel!,
      fetchImpl
    }) : createInactiveImagePlanner(),
    imageGeneration: imageGenerationPath === "headless" ? createOpenAiCompatibleImageProvider({
      baseUrl: config.imageProviderBaseUrl!,
      apiKey: config.imageProviderApiKey!,
      model: config.imageProviderModel!,
      fetchImpl
    }) : createInactiveImageGenerationAdapter(),
    assetPublishing: config.assetPublishS3Endpoint && config.assetPublishS3Region && config.assetPublishS3Bucket && config.assetPublishS3AccessKeyId && config.assetPublishS3SecretAccessKey && config.assetPublishPublicBaseUrl
      ? createAssetPublishingAdapter({
          s3Endpoint: config.assetPublishS3Endpoint,
          s3Region: config.assetPublishS3Region,
          s3Bucket: config.assetPublishS3Bucket,
          s3AccessKeyId: config.assetPublishS3AccessKeyId,
          s3SecretAccessKey: config.assetPublishS3SecretAccessKey,
          publicBaseUrl: config.assetPublishPublicBaseUrl,
          assetRoot: config.assetRoot,
          fetchImpl
        })
      : createStubAssetPublishingAdapter(),
    counters: () => Object.freeze({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 })
  };
}

function inactivePathError(): Error {
  return new Error("adapter factory: adapter is not active for the configured image generation path");
}

function createInactiveCanvasAdapter(): CanvasPort {
  return {
    async readWorkflowCapacity() { throw inactivePathError(); },
    async submit() { throw inactivePathError(); },
    async fetchOutputs() { throw inactivePathError(); }
  };
}

function createInactiveAssetStagingAdapter(): AssetStagingPort {
  return {
    async stage() { throw inactivePathError(); },
    async release() { throw inactivePathError(); }
  };
}

function createInactiveImagePlanner(): ImagePromptPlannerPort {
  return { async plan() { throw inactivePathError(); } };
}

function createInactiveImageGenerationAdapter(): ImageGenerationPort {
  return {
    async submit() { throw inactivePathError(); },
    async fetch() { throw inactivePathError(); }
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

function createStubAssetPublishingAdapter() {
  // Stub adapter for when S3 config is not provided.
  return {
    async publish({ assets }: { assets: Array<{ assetId: string; localPath: string; extension: string }>; purpose: string }) {
      return assets.map((asset) => ({
        remoteUrl: `https://cdn.mock/images/${asset.assetId}.${asset.extension}`
      }));
    },
    async release() {}
  } satisfies AssetPublishingPort;
}
