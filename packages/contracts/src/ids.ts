// Branded identifier types. Useful at compile time to prevent mixing IDs across aggregates.
// Constructors are *not* parsers — domain layers validate semantic shape, then coerce.

declare const __idBrand: unique symbol;
type IdBrand<T extends string> = T & { readonly [__idBrand]: never };

export type OperatorId = IdBrand<"OperatorId">;
export type ProductId = IdBrand<"ProductId">;
export type ProductRevisionId = IdBrand<"ProductRevisionId">;
export type SourceShopId = IdBrand<"SourceShopId">;
export type SourceItemId = IdBrand<"SourceItemId">;
export type MiaoshouDetailId = IdBrand<"MiaoshouDetailId">;
export type MiaoshouSourceRecordId = IdBrand<"MiaoshouSourceRecordId">;
export type BatchId = IdBrand<"BatchId">;
export type IdempotencyKey = IdBrand<"IdempotencyKey">;
export type SkuId = IdBrand<"SkuId">;
export type SkuDimensionId = IdBrand<"SkuDimensionId">;
export type AssetId = IdBrand<"AssetId">;
export type ListingDraftId = IdBrand<"ListingDraftId">;
export type ListingGenerationRunId = IdBrand<"ListingGenerationRunId">;
export type PricingRunId = IdBrand<"PricingRunId">;
export type ExchangeRateSnapshotId = IdBrand<"ExchangeRateSnapshotId">;
export type AutomationRunId = IdBrand<"AutomationRunId">;
export type CanvasRunId = IdBrand<"CanvasRunId">;
export type ApprovalSnapshotId = IdBrand<"ApprovalSnapshotId">;
export type MiaoshouSyncId = IdBrand<"MiaoshouSyncId">;
export type JobId = IdBrand<"JobId">;
export type WorkerInstanceId = IdBrand<"WorkerInstanceId">;
export type TemplateId = IdBrand<"TemplateId">;
export type AuditEventId = IdBrand<"AuditEventId">;

const brand = <B extends string>(raw: string): IdBrand<B> => raw as unknown as IdBrand<B>;

export const operatorId = (raw: string): OperatorId => brand<"OperatorId">(raw);
export const productId = (raw: string): ProductId => brand<"ProductId">(raw);
export const productRevisionId = (raw: string): ProductRevisionId => brand<"ProductRevisionId">(raw);
export const sourceShopId = (raw: string): SourceShopId => brand<"SourceShopId">(raw);
export const sourceItemId = (raw: string): SourceItemId => brand<"SourceItemId">(raw);
export const miaoshouDetailId = (raw: string): MiaoshouDetailId => brand<"MiaoshouDetailId">(raw);
export const miaoshouSourceRecordId = (raw: string): MiaoshouSourceRecordId =>
  brand<"MiaoshouSourceRecordId">(raw);
export const batchId = (raw: string): BatchId => brand<"BatchId">(raw);
export const idempotencyKey = (raw: string): IdempotencyKey => brand<"IdempotencyKey">(raw);
export const skuId = (raw: string): SkuId => brand<"SkuId">(raw);
export const skuDimensionId = (raw: string): SkuDimensionId => brand<"SkuDimensionId">(raw);
export const assetId = (raw: string): AssetId => brand<"AssetId">(raw);
export const listingDraftId = (raw: string): ListingDraftId => brand<"ListingDraftId">(raw);
export const listingGenerationRunId = (raw: string): ListingGenerationRunId =>
  brand<"ListingGenerationRunId">(raw);
export const pricingRunId = (raw: string): PricingRunId => brand<"PricingRunId">(raw);
export const exchangeRateSnapshotId = (raw: string): ExchangeRateSnapshotId =>
  brand<"ExchangeRateSnapshotId">(raw);
export const automationRunId = (raw: string): AutomationRunId => brand<"AutomationRunId">(raw);
export const canvasRunId = (raw: string): CanvasRunId => brand<"CanvasRunId">(raw);
export const approvalSnapshotId = (raw: string): ApprovalSnapshotId =>
  brand<"ApprovalSnapshotId">(raw);
export const miaoshouSyncId = (raw: string): MiaoshouSyncId => brand<"MiaoshouSyncId">(raw);
export const jobId = (raw: string): JobId => brand<"JobId">(raw);
export const workerInstanceId = (raw: string): WorkerInstanceId => brand<"WorkerInstanceId">(raw);
export const templateId = (raw: string): TemplateId => brand<"TemplateId">(raw);
export const auditEventId = (raw: string): AuditEventId => brand<"AuditEventId">(raw);
