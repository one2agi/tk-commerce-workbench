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
  canonicalSourceTitle: string | null;
  targetTitle: string | null;
  canonicalSuccessDetailId: MiaoshouDetailId | null;
  locale: Locale;
  currency: MoneyWire["currency"];
  priceWire: MoneyWire | null;
  /** Total archived source/product images available before Canvas generation. */
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
  pricingRunId: string;
  templateVersion: number;
  orderedFinalAssetIds: AssetId[];
  locale: Locale;
  currency: MoneyWire["currency"];
  finalPriceWire: MoneyWire | null;
  warningCodes: string[];
  miaoshouTargetDetailId: MiaoshouDetailId | null;
}>;

export type ApprovalSnapshotV1 = Readonly<{
  approvalSnapshotId: string;
  productId: ProductId;
  revisionId: ProductRevisionId;
  draftVersion: number;
  listingRunId: string;
  pricingRunId: string;
  templateVersion: number;
  orderedFinalAssetIds: AssetId[];
  sourcePlatform: "1688";
  sourceCanonicalUrl: string;
  sourceItemId: SourceItemId;
  canonicalSuccessDetailId: MiaoshouDetailId;
  locale: Locale;
  currency: MoneyWire["currency"];
  title: string;
  description: string;
  attributes: Array<{ name: string; value: string }>;
  itemNumber: string | null;
  priceWire: MoneyWire;
  stock: number;
  weightKg: string;
  dimensions: { lengthCm: string; widthCm: string; heightCm: string } | null;
  skus: Array<{
    skuId: string;
    attributes: Record<string, string>;
    priceWire: MoneyWire;
    stock: number;
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
