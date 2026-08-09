// Deterministic fake ports, intended for unit tests in every lane and for the Wave 2 cost
// boundary assertion ("LLM calls = 0, exchange-rate calls = 0, Canvas calls = 0" before
// explicit start). These are NOT exported from @tk/adapters — lanes must never accidentally
// import the live adapters in test mode.

import type {
  AssetStagingPort,
  CanvasPort,
  CanvasReadCapacityResult,
  CanvasSubmitResult,
  CanvasFetchOutputsResult,
  ExchangeRatePort,
  ImageGenerationPort,
  ImagePromptPlannerPort,
  LlmPort,
  LlmStructuredOutputV1,
  MiaoshouCollectedDetail,
  MiaoshouEditApplyResult,
  MiaoshouEditFieldError,
  MiaoshouEditPort,
  MiaoshouSourceCollectResult,
  MiaoshouSourcePort,
  PlannedImagePromptV1,
  StagedAsset
} from "../ports.js";
import type { ExchangeRateSnapshotWire } from "../quantities.js";
import type { ExternalFailure } from "../errors.js";
import type { IdempotencyKey, SourceItemId } from "../ids.js";
import type { ApprovalSnapshotV1 } from "../read-models.js";

class FakeMiaoshouSource implements MiaoshouSourcePort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public responses: MiaoshouSourceCollectResult[] = [];

  async fetchItem(input: { sourceUrl: string; idempotencyKey: IdempotencyKey }): Promise<MiaoshouSourceCollectResult> {
    this.calls.push({ method: "fetchItem", input });
    if (this.responses.length === 0) {
      throw new Error("FakeMiaoshouSource: no scripted response");
    }
    const next = this.responses.shift();
    if (!next) {
      throw new Error("FakeMiaoshouSource: response queue empty");
    }
    return next;
  }

  async resolveCanonicalSuccessDetail(input: { sourceItemId: SourceItemId }) {
    this.calls.push({ method: "resolveCanonicalSuccessDetail", input });
    if (this.responses.length === 0) {
      throw new Error("FakeMiaoshouSource: no scripted detail response");
    }
    const next = this.responses.shift();
    if (!next) {
      throw new Error("FakeMiaoshouSource: response queue empty");
    }
    return { canonicalSuccessDetailId: next.canonicalSuccessDetailId, detail: next.detail };
  }
}

class FakeMiaoshouEdit implements MiaoshouEditPort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public responses: MiaoshouEditApplyResult[] = [];

  async applyEdit(input: {
    approvalSnapshot: ApprovalSnapshotV1;
    orderedRemoteAssetUrls: string[];
    idempotencyKey: IdempotencyKey;
  }): Promise<MiaoshouEditApplyResult> {
    this.calls.push({ method: "applyEdit", input });
    if (this.responses.length === 0) {
      throw new Error("FakeMiaoshouEdit: no scripted response");
    }
    const next = this.responses.shift();
    if (!next) {
      throw new Error("FakeMiaoshouEdit: response queue empty");
    }
    return next;
  }

  async reconcileByCanonicalDetailId(input: { canonicalSuccessDetailId: string; sourceItemId: SourceItemId }) {
    this.calls.push({ method: "reconcileByCanonicalDetailId", input });
    return { remoteDetailId: input.canonicalSuccessDetailId, state: "applied" as const };
  }
}

class FakeCanvas implements CanvasPort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public capacityResult: CanvasReadCapacityResult = {
    workflowId: "TKWorkflow",
    workflowVersion: 1,
    inputCapacity: 9,
    expectedOutputCount: 5
  };
  public submitResult: CanvasSubmitResult = { remoteTaskId: "canvas_task_01", submittedAt: "2026-07-15T00:00:00Z" };
  public outputsResult: CanvasFetchOutputsResult = {
    outputs: Array.from({ length: 5 }, (_, i) => ({
      url: `https://canvas.test/out/${i}.png`,
      width: 1024,
      height: 1024,
      sha256: `canvas_out_${i}`
    }))
  };

  async readWorkflowCapacity(workflowId: string): Promise<CanvasReadCapacityResult> {
    this.calls.push({ method: "readWorkflowCapacity", input: { workflowId } });
    return this.capacityResult;
  }

  async submit(input: Parameters<CanvasPort["submit"]>[0]): Promise<CanvasSubmitResult> {
    this.calls.push({ method: "submit", input });
    return this.submitResult;
  }

  async fetchOutputs(input: Parameters<CanvasPort["fetchOutputs"]>[0]): Promise<CanvasFetchOutputsResult> {
    this.calls.push({ method: "fetchOutputs", input });
    return this.outputsResult;
  }
}

class FakeLlm implements LlmPort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public output: LlmStructuredOutputV1 = {
    title: "translated title",
    description: "translated description",
    translatedAttributes: [],
    styleApplied: "neutral",
    fallbackUsed: false
  };

  async generateListing(input: Parameters<LlmPort["generateListing"]>[0]): Promise<LlmStructuredOutputV1> {
    this.calls.push({ method: "generateListing", input });
    return this.output;
  }
}

class FakeExchangeRate implements ExchangeRatePort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public snapshot: ExchangeRateSnapshotWire = {
    base: "CNY",
    target: "THB",
    rate: "4.80",
    source: "provider",
    observedAt: "2026-07-15T00:00:00Z",
    isStale: false
  };

  async fetchSnapshot(input: Parameters<ExchangeRatePort["fetchSnapshot"]>[0]): Promise<ExchangeRateSnapshotWire> {
    this.calls.push({ method: "fetchSnapshot", input });
    return this.snapshot;
  }

  async latestSnapshot(input: Parameters<ExchangeRatePort["latestSnapshot"]>[0]): Promise<ExchangeRateSnapshotWire | null> {
    this.calls.push({ method: "latestSnapshot", input });
    return this.snapshot;
  }

  async recordManualOverride(input: Parameters<ExchangeRatePort["recordManualOverride"]>[0]): Promise<ExchangeRateSnapshotWire> {
    this.calls.push({ method: "recordManualOverride", input });
    this.snapshot = { ...this.snapshot, rate: input.rate, source: "manual", isStale: false };
    return this.snapshot;
  }
}

class FakeAssetStaging implements AssetStagingPort {
  public readonly calls: { method: string; input: unknown }[] = [];

  async stage(input: { localAssetIds: string[]; purpose: "canvas" | "miaoshou_edit" }): Promise<StagedAsset[]> {
    this.calls.push({ method: "stage", input });
    const localAssetIds = input.localAssetIds;
    return localAssetIds.map((id: string, i: number) => ({
      remoteUrl: `https://staging.test/${id}-${i}`,
      expiresAt: "2026-07-15T01:00:00Z"
    }));
  }

  async release(input: { remoteUrls: string[] }): Promise<void> {
    this.calls.push({ method: "release", input });
  }
}

class FakeImagePlanner implements ImagePromptPlannerPort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public planResult: { prompts: PlannedImagePromptV1[] } = {
    prompts: [{ slot: 1, role: "hero", prompt: "fake prompt", mustPreserve: [], forbidden: [] }]
  };

  async plan(input: Parameters<ImagePromptPlannerPort["plan"]>[0]): Promise<{ prompts: PlannedImagePromptV1[] }> {
    this.calls.push({ method: "plan", input });
    return this.planResult;
  }
}

class FakeImageGeneration implements ImageGenerationPort {
  public readonly calls: { method: string; input: unknown }[] = [];
  public submitResult: Awaited<ReturnType<ImageGenerationPort["submit"]>> = { kind: "completed", outputUrl: "https://images.test/fake.png" };
  public fetchResult: Awaited<ReturnType<ImageGenerationPort["fetch"]>> = { state: "succeeded", outputUrl: "https://images.test/fake.png" };

  async submit(input: Parameters<ImageGenerationPort["submit"]>[0]): Promise<{ kind: "completed"; outputUrl: string } | { kind: "accepted"; remoteTaskId: string }> {
    this.calls.push({ method: "submit", input });
    return this.submitResult as { kind: "completed"; outputUrl: string } | { kind: "accepted"; remoteTaskId: string };
  }

  async fetch(input: Parameters<ImageGenerationPort["fetch"]>[0]): Promise<{ state: "pending" } | { state: "succeeded"; outputUrl: string } | { state: "failed"; failure: ExternalFailure }> {
    this.calls.push({ method: "fetch", input });
    return this.fetchResult as { state: "pending" } | { state: "succeeded"; outputUrl: string } | { state: "failed"; failure: ExternalFailure };
  }
}

export interface FakePortCounters {
  readonly miaoshouSource: number;
  readonly miaoshouEdit: number;
  readonly canvas: number;
  readonly llm: number;
  readonly exchangeRate: number;
  readonly assetStaging: number;
  readonly imagePlanner: number;
  readonly imageGeneration: number;
}

export interface FakePorts {
  readonly miaoshouSource: FakeMiaoshouSource;
  readonly miaoshouEdit: FakeMiaoshouEdit;
  readonly canvas: FakeCanvas;
  readonly llm: FakeLlm;
  readonly exchangeRate: FakeExchangeRate;
  readonly assetStaging: FakeAssetStaging;
  readonly imagePlanner: FakeImagePlanner;
  readonly imageGeneration: FakeImageGeneration;
  counters(): FakePortCounters;
  reset(): void;
}

export function createFakePorts(): FakePorts {
  const miaoshouSource = new FakeMiaoshouSource();
  const miaoshouEdit = new FakeMiaoshouEdit();
  const canvas = new FakeCanvas();
  const llm = new FakeLlm();
  const exchangeRate = new FakeExchangeRate();
  const assetStaging = new FakeAssetStaging();
  const imagePlanner = new FakeImagePlanner();
  const imageGeneration = new FakeImageGeneration();

  return {
    miaoshouSource,
    miaoshouEdit,
    canvas,
    llm,
    exchangeRate,
    assetStaging,
    imagePlanner,
    imageGeneration,
    counters: () => ({
      miaoshouSource: miaoshouSource.calls.length,
      miaoshouEdit: miaoshouEdit.calls.length,
      canvas: canvas.calls.length,
      llm: llm.calls.length,
      exchangeRate: exchangeRate.calls.length,
      assetStaging: assetStaging.calls.length,
      imagePlanner: imagePlanner.calls.length,
      imageGeneration: imageGeneration.calls.length
    }),
    reset: () => {
      miaoshouSource.calls.length = 0;
      miaoshouEdit.calls.length = 0;
      canvas.calls.length = 0;
      llm.calls.length = 0;
      exchangeRate.calls.length = 0;
      assetStaging.calls.length = 0;
      imagePlanner.calls.length = 0;
      imageGeneration.calls.length = 0;
      miaoshouSource.responses = [];
      miaoshouEdit.responses = [];
    }
  };
}

// Convenience export so adapter tests can grab a real-looking failure object.
export function fakeExternalFailure(partial: Partial<ExternalFailure>): ExternalFailure {
  return Object.freeze({
    kind: partial.kind ?? "retryable",
    code: partial.code ?? "test.fake",
    safeMessage: partial.safeMessage ?? "fake failure"
  });
}

export function emptyMiaoshouDetail(): MiaoshouCollectedDetail {
  return {
    detailId: "detail_test",
    sourceItemId: "0" as unknown as SourceItemId,
    sourceUrl: "https://detail.1688.com/offer/0.html",
    title: "",
    itemNumber: null,
    description: "",
    category: null,
    sourcePriceWire: null,
    sourceStock: null,
    weightKg: null,
    dimensionsCm: null,
    mainImages: [],
    detailImages: [],
    sourceAttributes: [],
    saleAttributes: [],
    colors: [],
    sizes: [],
    skus: []
  };
}

export function emptyFieldErrors(): MiaoshouEditFieldError[] {
  return [];
}
