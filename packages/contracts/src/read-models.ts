// Serializable read models for API + UI. These are projections over the per-aggregate state
// machine, NOT new persisted state. UI stage counts must derive from these projections, and
// the user must never be allowed to drag a row into a different status.

import type { AssetId, JobId, ProductId, ProductRevisionId, SourceItemId, TemplateId, WorkerInstanceId } from "./ids.js";
import type { MiaoshouDetailId } from "./ids.js";
import type { ExchangeRateSnapshotWire, MoneyWire } from "./quantities.js";
import type {
  ApprovalState,
  AssetArchiveState,
  AutomationState,
  CanvasState,
  JobStatus,
  ListingState,
  MiaoshouEditState,
  MiaoshouSourceState
} from "./states.js";
import type { ExternalFailure } from "./errors.js";

export type Locale = string; // BCP-47; default "th-TH".

export type ProductPoolItemV1 = Readonly<{
  productId: ProductId;
  currentRevisionId: ProductRevisionId;
  sourceItemId: SourceItemId | null;
  sourceUrl: string;
  thumbnailUrl: string | null;
  /** Collected source images, main images first and detail images second. */
  originalImageUrls: string[];
  /** Valid outputs from the latest Canvas run; never includes source images. */
  processedImageUrls: string[];
  collectedAt: string;
  updatedAt: string;
  canonicalSourceTitle: string | null;
  targetTitle: string | null;
  canonicalSuccessDetailId: MiaoshouDetailId | null;
  locale: Locale;
  currency: MoneyWire["currency"];
  priceWire: MoneyWire | null;
  /** Original 1688 purchase price captured in CNY; independent from target pricing. */
  sourcePriceWire?: MoneyWire | null;
  /** Product images available in the original Miaoshou collect-box payload before local archiving. */
  sourceImageCount: number;
  /** Validation marker for browser-local 1688 captures; null for Miaoshou-sourced products. */
  sourceCaptureQuality: string | null;
  /** Total archived source/product images available after automation starts. */
  imageCount: number;
  /** Valid images returned by the latest Canvas run; excludes source images. */
  usableCanvasOutputCount: number;
  miaoshouSource: MiaoshouSourceState;
  automation: AutomationState;
  assetArchive: AssetArchiveState;
  listing: ListingState;
  canvas: CanvasState;
  approval: ApprovalState;
  miaoshouEdit: MiaoshouEditState;
  warningCodes: string[];
}>;

export type ProductWorkspaceV1 = Readonly<{
  productId: ProductId;
  revisionId: ProductRevisionId;
  draftVersion: number;
  originalListing: {
    sourceTitle: string;
    description: string;
    sourceAttributes: Array<{ name: string; value: string }>;
    saleAttributes: Array<{ name: string; value: string }>;
    mainImages: string[];
    detailImages: string[];
  } | null;
  target: {
    locale: Locale;
    title: string;
    description: string;
    style: string;
    provider: string;
    model: string;
    fallbackUsed: boolean;
  } | null;
  pricing: {
    pricingRunId: string;
    currency: MoneyWire["currency"];
    finalPriceWire: MoneyWire | null;
    breakdown: Record<string, string>;
    exchangeRate: ExchangeRateSnapshotWire | null;
  } | null;
  template: { templateId: TemplateId; version: number; matchedReason: string } | null;
  canvas: { runId: string; outputs: string[]; state: CanvasState } | null;
  imageGeneration: ImageGenerationViewV1 | null;
  finalAssetOrder: AssetId[];
  warningCodes: string[];
}>;

export type TaskCenterItemV1 = Readonly<{
  jobId: JobId;
  kind: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  pauseReason: string | null;
  owner: WorkerInstanceId | null;
  error: ExternalFailure | null;
  revisionId: ProductRevisionId | null;
}>;

export type ApprovalPreviewV1 = Readonly<{
  productId: ProductId;
  draftVersion: number;
  listingRunId: string;
  pricingRunId?: string | null;
  templateVersion: number;
  orderedFinalAssetIds: AssetId[];
  locale: Locale;
  currency: MoneyWire["currency"];
  finalPriceWire: MoneyWire | null;
  warningCodes: string[];
  miaoshouTargetDetailId: MiaoshouDetailId | null;
  miaoshouWriteback: Readonly<{
    state: "not_started" | "queued" | "syncing" | "succeeded" | "failed" | "result_unknown";
    failureCode: string | null;
    safeMessage: string | null;
    retryAllowed: boolean;
    approvalSnapshotId: string | null;
  }>;
}>;

export type ApprovalSnapshotV1 = Readonly<{
  approvalSnapshotId: string;
  productId: ProductId;
  revisionId: ProductRevisionId;
  draftVersion: number;
  listingRunId: string;
  pricingRunId?: string | null;
  templateVersion: number;
  orderedFinalAssetIds: AssetId[];
  orderedFinalAssetLocalPaths?: string[];
  orderedFinalAssetSha256?: string[];
  orderedFinalAssetExtension?: string[];
  sourcePlatform: "1688";
  sourceCanonicalUrl: string;
  sourceItemId: SourceItemId;
  canonicalSuccessDetailId: MiaoshouDetailId | null;
  locale: Locale;
  currency: MoneyWire["currency"];
  title: string;
  description: string;
  attributes: Array<{ name: string; value: string }>;
  itemNumber: string | null;
  priceWire?: MoneyWire | null;
  stock?: number | null;
  weightKg?: string | null;
  dimensions: { lengthCm: string; widthCm: string; heightCm: string } | null;
  skus: Array<{
    skuId: string;
    attributes: Record<string, string>;
    priceWire?: MoneyWire | null;
    stock?: number | null;
    assetIds: AssetId[];
  }>;
  createdAt: string;
}>;

export type TemplateV1 = Readonly<{
  templateId: TemplateId;
  name: string;
  categoryRules: Array<{ categoryKey: string; priority: number }>;
  referenceAssetIds: AssetId[];
  promptFragment: string;
  targetLocale: Locale;
  visualStyle: string;
  enabled: boolean;
  version: number;
}>;

export type WorkspaceSettingsViewV1 = Readonly<{
  defaultLocale: Locale;
  defaultCurrency: MoneyWire["currency"];
  externalAdapterMode: "mock" | "live";
  secretStatus: {
    miaoshouConfigured: boolean;
    canvasConfigured: boolean;
    llmConfigured: boolean;
    exchangeRateConfigured: boolean;
    imageGenerationConfigured: boolean;
    imageGenerationPath: "canvas" | "headless";
  };
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
  assetRoot: string;
}>;

export type MiaoshouSyncStatusV1 = Readonly<{
  syncId: string;
  approvalSnapshotId: string;
  state: MiaoshouEditState;
  remoteDetailId: MiaoshouDetailId | null;
  lastReconciledAt: string | null;
  error: ExternalFailure | null;
}>;

export type ImageGenerationSlotViewV1 = Readonly<{
  slotId: string;
  slotNumber: number;
  role: string;
  status: string;
  attempt: number;
  localUrl: string | null;
  error: string | null;
}>;

export type ImageGenerationViewV1 = Readonly<{
  batchId: string | null;
  availableInputs: ReadonlyArray<{ assetId: AssetId; localUrl: string; role: string | null }>;
  selectedInputs: ReadonlyArray<{ assetId: AssetId; localUrl: string }>;
  inferredCategory: string | null;
  confirmedCategory: string | null;
  requestedCount: number;
  successfulCount: number;
  state: "not_started" | "planning" | "generating" | "partial" | "succeeded" | "failed";
  slots: ReadonlyArray<ImageGenerationSlotViewV1>;
  warnings: string[];
}>;

export type ImageGenerationTemplateViewV1 = Readonly<{
  templateId: TemplateId;
  name: string;
  categoryKey: string;
  parentCategoryKey: string | null;
  version: number;
  lifecycleState: "draft" | "active" | "archived";
  recipe: Readonly<{
    inputCounts: { default: number; min: number; max: number };
    outputCounts: { default: number; min: number; max: number };
    mustPreserve: string[];
    visualDirection: string;
    forbidden: string[];
    roles: Array<{ key: string; instruction: string }>;
  }>;
  activatedAt: string | null;
  createdAt: string;
}>;
