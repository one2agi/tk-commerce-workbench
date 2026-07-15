import type { AppConfig } from "@tk/config";
import type { AssetStagingPort, CanvasPort, ExchangeRatePort, LlmPort } from "@tk/contracts";
import { createCanvasAdapter } from "./canvas/canvas-adapter.js";
import { createExchangeRateAdapter } from "./exchange-rate/exchange-rate-adapter.js";
import { createOpenAiCompatibleAdapter } from "./llm/openai-compatible-adapter.js";
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
  "canvasBaseUrl" | "canvasApiKey" | "llmBaseUrl" | "llmApiKey" | "llmModel" | "exchangeRateBaseUrl"
>> & Pick<AppConfig, "externalAdapterMode" | "nodeEnv" | "assetRoot"> & {
  readonly processKind?: "app" | "test" | "integration" | "e2e";
};

export interface AdapterFactoryDeps {
  readonly constructLive?: (config: AdapterFactoryConfig, context: LiveCommandContext) => AdapterBundle;
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
  return (deps.constructLive ?? constructLiveAdapters)(config, commandContext);
}

function constructLiveAdapters(config: AdapterFactoryConfig, _context: LiveCommandContext): AdapterBundle {
  if (!config.canvasBaseUrl || !config.canvasApiKey || !config.llmBaseUrl || !config.llmApiKey || !config.llmModel || !config.exchangeRateBaseUrl) {
    throw new Error("adapter factory: live adapter configuration is incomplete");
  }
  return {
    mode: "live",
    canvas: createCanvasAdapter({ baseUrl: config.canvasBaseUrl, apiKey: config.canvasApiKey, canvasId: "0f91cb2d8f2846c091829af30ea2d18d", workflowName: "TK工作流" }),
    llm: createOpenAiCompatibleAdapter({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel }),
    exchangeRate: createExchangeRateAdapter({ baseUrl: config.exchangeRateBaseUrl }),
    assetStaging: createAssetStagingAdapter({ publicBaseUrl: "http://127.0.0.1:3000/api/v1/assets" }),
    counters: () => Object.freeze({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 })
  };
}

function isStableCommandContext(context: LiveCommandContext | undefined): context is LiveCommandContext {
  return Boolean(context && context.kind === "worker_command" && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,}$/.test(context.commandId) && /^[A-Za-z0-9][A-Za-z0-9:_-]{7,}$/.test(context.idempotencyKey));
}
