import type {
  AssetStagingPort,
  CanvasPort,
  ExchangeRatePort,
  ExchangeRateSnapshotWire,
  LlmPort
} from "@tk/contracts";

export interface AdapterCallCounters {
  readonly canvas: number;
  readonly llm: number;
  readonly exchangeRate: number;
  readonly assetStaging: number;
}

export interface DeterministicAdapterFakes {
  readonly canvas: CanvasPort;
  readonly llm: LlmPort;
  readonly exchangeRate: ExchangeRatePort;
  readonly assetStaging: AssetStagingPort;
  counters(): AdapterCallCounters;
  reset(): void;
}

export function createDeterministicAdapterFakes(): DeterministicAdapterFakes {
  const counts = { canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 };
  let rate: ExchangeRateSnapshotWire = { base: "CNY", target: "THB", rate: "4.80", source: "provider", observedAt: "2026-07-16T00:00:00.000Z", isStale: false };
  const canvas: CanvasPort = {
    async readWorkflowCapacity(workflowId) { counts.canvas += 1; return { workflowId, workflowVersion: 1, inputCapacity: 9, expectedOutputCount: 5 }; },
    async submit() { counts.canvas += 1; return { remoteTaskId: "mock_canvas_task_01", submittedAt: "2026-07-16T00:00:00.000Z" }; },
    async fetchOutputs() { counts.canvas += 1; return { outputs: Array.from({ length: 5 }, (_, i) => ({ url: `https://canvas.mock/output-${i + 1}.png`, width: 1024, height: 1024, sha256: String(i + 1).repeat(64) })) }; }
  };
  const llm: LlmPort = {
    async generateListing(input) { counts.llm += 1; return { title: input.evidence.sourceTitle, description: input.evidence.sourceDescription, translatedAttributes: input.evidence.sourceAttributes, styleApplied: input.style, fallbackUsed: false }; }
  };
  const exchangeRate: ExchangeRatePort = {
    async fetchSnapshot() { counts.exchangeRate += 1; return rate; },
    async latestSnapshot() { counts.exchangeRate += 1; return rate; },
    async recordManualOverride(input) { counts.exchangeRate += 1; rate = { base: input.base, target: input.target, rate: input.rate, source: "manual", observedAt: "2026-07-16T00:00:00.000Z", isStale: false }; return rate; }
  };
  const assetStaging: AssetStagingPort = {
    async stage(input) { counts.assetStaging += 1; return input.localAssetIds.map((id) => ({ remoteUrl: `https://staging.mock/${encodeURIComponent(id)}`, expiresAt: "2026-07-16T01:00:00.000Z" })); },
    async release() { counts.assetStaging += 1; }
  };
  return {
    canvas, llm, exchangeRate, assetStaging,
    counters: () => Object.freeze({ ...counts }),
    reset() { counts.canvas = 0; counts.llm = 0; counts.exchangeRate = 0; counts.assetStaging = 0; }
  };
}
