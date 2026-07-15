// Adapter ports. These are the only surface that Worker/domain code talks to. Concrete
// implementations live in @tk/adapters. Tests, Core and Web import these and the fakes
// from @tk/contracts/testing — never the concrete adapters — to keep mock/live isolation.

import type { ApprovalSnapshotV1 } from "./read-models.js";
import type { ExchangeRateSnapshotWire } from "./quantities.js";
import type { ExchangeRateSnapshotId, IdempotencyKey, SourceItemId } from "./ids.js";
import type { ExternalFailure } from "./errors.js";

// ----- Miaoshou source collection -----

export type MiaoshouCollectedDetail = Readonly<{
  detailId: string;
  sourceItemId: SourceItemId;
  sourceUrl: string;
  title: string;
  itemNumber: string | null;
  description: string;
  category: string | null;
  sourcePriceWire: { amountMinor: string; currency: "CNY" } | null;
  sourceStock: number | null;
  weightKg: string | null;
  dimensionsCm: { lengthCm: string; widthCm: string; heightCm: string } | null;
  mainImages: Array<{ url: string; width: number; height: number }>;
  detailImages: Array<{ url: string; width: number; height: number }>;
  sourceAttributes: Array<{ name: string; value: string }>;
  saleAttributes: Array<{ name: string; value: string }>;
  colors: string[];
  sizes: string[];
  skus: Array<{
    skuId: string;
    attributes: Record<string, string>;
    priceWire: { amountMinor: string; currency: "CNY" };
    stock: number | null;
    imageUrl: string | null;
  }>;
}>;

export type MiaoshouSourceCollectResult = Readonly<{
  fetchDetailId: string | null;
  skippedDetailId: string | null;
  canonicalSuccessDetailId: string;
  detail: MiaoshouCollectedDetail;
}>;

export interface MiaoshouSourcePort {
  fetchItem(input: {
    sourceUrl: string;
    idempotencyKey: IdempotencyKey;
  }): Promise<MiaoshouSourceCollectResult>;

  resolveCanonicalSuccessDetail(input: {
    sourceItemId: SourceItemId;
  }): Promise<{ canonicalSuccessDetailId: string; detail: MiaoshouCollectedDetail }>;
}

// ----- Miaoshou edit -----

export type MiaoshouEditFieldError = Readonly<{
  fieldPath: string;
  message: string; // safe to display
}>;

export type MiaoshouEditApplyResult =
  | { kind: "succeeded"; remoteDetailId: string }
  | { kind: "validation_failed"; fieldErrors: MiaoshouEditFieldError[] }
  | { kind: "needs_reconcile"; failure: ExternalFailure; remoteTaskId: string | null };

export interface MiaoshouEditPort {
  applyEdit(input: {
    approvalSnapshot: ApprovalSnapshotV1;
    orderedRemoteAssetUrls: string[];
    idempotencyKey: IdempotencyKey;
  }): Promise<MiaoshouEditApplyResult>;

  reconcileByCanonicalDetailId(input: {
    canonicalSuccessDetailId: string;
    sourceItemId: SourceItemId;
  }): Promise<{ remoteDetailId: string; state: "applied" | "no_change" | "missing" }>;
}

// ----- Canvas -----

export type CanvasReadCapacityResult = Readonly<{
  workflowId: string;
  workflowVersion: number;
  inputCapacity: number;
  expectedOutputCount: number;
}>;

export type CanvasSubmitResult = Readonly<{
  remoteTaskId: string;
  submittedAt: string;
}>;

export type CanvasFetchOutputsResult = Readonly<{
  outputs: Array<{ url: string; width: number; height: number; sha256: string }>;
}>;

export interface CanvasPort {
  readWorkflowCapacity(workflowId: string): Promise<CanvasReadCapacityResult>;
  submit(input: {
    workflowId: string;
    workflowVersion: number;
    imageUrls: string[];
    referenceImageUrls: string[];
    promptContext: { sourceLocale: string; targetLocale: string; style: string };
    idempotencyKey: IdempotencyKey;
  }): Promise<CanvasSubmitResult>;
  fetchOutputs(input: { remoteTaskId: string }): Promise<CanvasFetchOutputsResult>;
}

// ----- LLM -----

export type LlmProvider = "openai_compatible" | "rules";

export type LlmStructuredOutputV1 = Readonly<{
  title: string;
  description: string;
  translatedAttributes: Array<{ name: string; value: string }>;
  styleApplied: string;
  fallbackUsed: boolean;
}>;

export interface LlmPort {
  generateListing(input: {
    sourceLocale: string;
    targetLocale: string;
    style: string;
    evidence: {
      sourceTitle: string;
      sourceDescription: string;
      sourceAttributes: Array<{ name: string; value: string }>;
    };
    idempotencyKey: IdempotencyKey;
  }): Promise<LlmStructuredOutputV1>;
}

// ----- Exchange rate -----

export interface ExchangeRatePort {
  fetchSnapshot(input: { base: "CNY"; target: "THB" }): Promise<ExchangeRateSnapshotWire>;
  latestSnapshot(input: { base: "CNY"; target: "THB" }): Promise<ExchangeRateSnapshotWire | null>;
  recordManualOverride(input: {
    base: "CNY";
    target: "THB";
    rate: string;
    snapshotId: ExchangeRateSnapshotId;
  }): Promise<ExchangeRateSnapshotWire>;
}

// ----- Asset staging -----

export type StagedAsset = Readonly<{
  remoteUrl: string;
  expiresAt: string;
}>;

export interface AssetStagingPort {
  stage(input: { localAssetIds: string[]; purpose: "canvas" | "miaoshou_edit" }): Promise<StagedAsset[]>;
  release(input: { remoteUrls: string[] }): Promise<void>;
}
