// Job kinds and payload snapshots. All job payloads are versioned; replaying an old payload
// against a newer schema must be rejected by the worker.

import type { ProductId, ProductRevisionId } from "./ids.js";
import type { JobStatus } from "./states.js";
import type { ExternalFailure } from "./errors.js";
import type { WorkerInstanceId } from "./ids.js";

export type JobKind =
  | "miaoshou_collect"
  | "miaoshou_prepare_writeback"
  | "asset_archive"
  | "listing_generate"
  | "pricing_calculate"
  | "template_match"
  | "image_select"
  | "exchange_rate_refresh"
  | "canvas_generate"
  | "final_preview"
  | "staging_cleanup"
  | "miaoshou_edit";

export const JOB_KIND_VERSION: Readonly<Record<JobKind, number>> = Object.freeze({
  miaoshou_collect: 1,
  miaoshou_prepare_writeback: 1,
  asset_archive: 1,
  listing_generate: 1,
  pricing_calculate: 1,
  template_match: 1,
  image_select: 1,
  exchange_rate_refresh: 1,
  canvas_generate: 1,
  final_preview: 1,
  staging_cleanup: 1,
  miaoshou_edit: 1
});

export type MiaoshouCollectPayloadV1 = Readonly<{
  version: 1;
  batchId: string;
  sourceUrl: string;
  idempotencyKey: string;
}>;

export type MiaoshouPrepareWritebackPayloadV1 = Readonly<{
  version: 1;
  approvalSnapshotId: string;
  productId: ProductId;
  revisionId: ProductRevisionId;
  sourceUrl: string;
  idempotencyKey: string;
}>;

export type AssetArchivePayloadV1 = Readonly<{
  version: 1;
  revisionId: ProductRevisionId;
  remoteUrls: string[];
}>;

export type ListingGeneratePayloadV1 = Readonly<{
  version: 1;
  revisionId: ProductRevisionId;
  targetLocale: string;
  style: string;
}>;

export type PricingCalculatePayloadV1 = Readonly<{
  version: 1;
  revisionId: ProductRevisionId;
}>;

export type TemplateMatchPayloadV1 = Readonly<{ version: 1; revisionId: ProductRevisionId }>;
export type ImageSelectPayloadV1 = Readonly<{ version: 1; revisionId: ProductRevisionId }>;

export type ExchangeRateRefreshPayloadV1 = Readonly<{
  version: 1;
  base: "CNY";
  target: "THB";
}>;

export type CanvasGeneratePayloadV1 = Readonly<{
  version: 1;
  revisionId: ProductRevisionId;
  revisionAssetOrder: string[];
  templateId: string;
  templateVersion: number;
}>;
export type FinalPreviewPayloadV1 = Readonly<{ version: 1; revisionId: ProductRevisionId }>;
export type StagingCleanupPayloadV1 = Readonly<{ version: 1; revisionId: ProductRevisionId; remoteUrls: string[] }>;

export type MiaoshouEditPayloadV1 = Readonly<{
  version: 1;
  approvalSnapshotId: string;
  productId: ProductId;
  canonicalSuccessDetailId: string;
}>;

export type MiaoshouCollectJob = { kind: "miaoshou_collect"; payload: MiaoshouCollectPayloadV1 };
export type MiaoshouPrepareWritebackJob = {
  kind: "miaoshou_prepare_writeback";
  payload: MiaoshouPrepareWritebackPayloadV1;
};
export type AssetArchiveJob = { kind: "asset_archive"; payload: AssetArchivePayloadV1 };
export type ListingGenerateJob = { kind: "listing_generate"; payload: ListingGeneratePayloadV1 };
export type PricingCalculateJob = { kind: "pricing_calculate"; payload: PricingCalculatePayloadV1 };
export type TemplateMatchJob = { kind: "template_match"; payload: TemplateMatchPayloadV1 };
export type ImageSelectJob = { kind: "image_select"; payload: ImageSelectPayloadV1 };
export type ExchangeRateRefreshJob = { kind: "exchange_rate_refresh"; payload: ExchangeRateRefreshPayloadV1 };
export type CanvasGenerateJob = { kind: "canvas_generate"; payload: CanvasGeneratePayloadV1 };
export type FinalPreviewJob = { kind: "final_preview"; payload: FinalPreviewPayloadV1 };
export type StagingCleanupJob = { kind: "staging_cleanup"; payload: StagingCleanupPayloadV1 };
export type MiaoshouEditJob = { kind: "miaoshou_edit"; payload: MiaoshouEditPayloadV1 };

export type JobSnapshot = Readonly<{
  jobId: string;
  kind: JobKind;
  businessKey: string;
  idempotencyKey: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  owner: WorkerInstanceId | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  remoteTaskId: string | null;
  error: ExternalFailure | null;
}>;
