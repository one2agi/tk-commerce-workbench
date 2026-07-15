// Schema barrel. The hand-written SQL in migrations/0000_initial.ts is the source of truth.
// TypeScript shapes here mirror those tables so repositories can speak a typed language.
// We deliberately avoid generating Drizzle runtime code in Wave 1; the SQL hand-roll is
// the contract with the eventual Drizzle build.

import type { Pool } from "pg";

export interface SchemaTables {
  readonly localOperators: "local_operators";
  readonly sourceShops: "source_shops";
  readonly products: "products";
  readonly productRevisions: "product_revisions";
  readonly miaoshouSourceRecords: "miaoshou_source_records";
  readonly skus: "skus";
  readonly skuDimensions: "sku_dimensions";
  readonly assets: "assets";
  readonly listingDrafts: "listing_drafts";
  readonly listingGenerationRuns: "listing_generation_runs";
  readonly pricingRuns: "pricing_runs";
  readonly exchangeRateSnapshots: "exchange_rate_snapshots";
  readonly automationRuns: "automation_runs";
  readonly canvasRuns: "canvas_runs";
  readonly canvasDailyReservations: "canvas_daily_reservations";
  readonly approvalSnapshots: "approval_snapshots";
  readonly miaoshouSyncs: "miaoshou_syncs";
  readonly jobs: "jobs";
  readonly workerInstances: "worker_instances";
  readonly auditEvents: "audit_events";
  readonly templates: "templates";
  readonly workspaceSettings: "workspace_settings";
}

export const schema: SchemaTables = Object.freeze({
  localOperators: "local_operators",
  sourceShops: "source_shops",
  products: "products",
  productRevisions: "product_revisions",
  miaoshouSourceRecords: "miaoshou_source_records",
  skus: "skus",
  skuDimensions: "sku_dimensions",
  assets: "assets",
  listingDrafts: "listing_drafts",
  listingGenerationRuns: "listing_generation_runs",
  pricingRuns: "pricing_runs",
  exchangeRateSnapshots: "exchange_rate_snapshots",
  automationRuns: "automation_runs",
  canvasRuns: "canvas_runs",
  canvasDailyReservations: "canvas_daily_reservations",
  approvalSnapshots: "approval_snapshots",
  miaoshouSyncs: "miaoshou_syncs",
  jobs: "jobs",
  workerInstances: "worker_instances",
  auditEvents: "audit_events",
  templates: "templates",
  workspaceSettings: "workspace_settings"
});

// Brand-shaped row types are kept structural (interfaces). Repositories don't need
// runtime type guards because SQL casting is the boundary.

export interface ProductRow {
  id: string;
  operatorId: string;
  sourceUrl: string;
  sourceItemId: string | null;
  locale: string;
  currency: string;
  canonicalSuccessDetailId: string | null;
  stateAutomation: string;
  stateAssetArchive: string;
  stateListing: string;
  stateCanvas: string;
  stateApproval: string;
  stateMiaoshouEdit: string;
  stateSource: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RevisionRow {
  id: string;
  productId: string;
  draftVersion: number;
  sourceTitle: string | null;
  sourcePayload: Record<string, unknown>;
  workingDraft: Record<string, unknown>;
  version: string;
  createdAt: Date;
}

export interface MiaoshouSourceRecordRow {
  id: string;
  productId: string;
  sourceItemId: string;
  fetchDetailId: string | null;
  skippedDetailId: string | null;
  canonicalSuccessDetailId: string | null;
  failureReason: string | null;
  fetchedPayload: Record<string, unknown>;
  state: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExchangeRateRow {
  id: string;
  base: string;
  target: string;
  rate: string;
  source: string;
  observedAt: Date;
  isStale: boolean;
  createdAt: Date;
}

export interface JobRow {
  id: string;
  kind: string;
  businessKey: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  owner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  remoteTaskId: string | null;
  error: unknown;
}

export interface AutomationRunRow {
  id: string;
  revisionId: string;
  processingVersion: number;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalSnapshotRow {
  id: string;
  productId: string;
  revisionId: string;
  draftVersion: number;
  listingRunId: string;
  pricingRunId: string;
  templateVersion: number;
  orderedFinalAssetIds: string[];
  sourcePlatform: string;
  sourceCanonicalUrl: string;
  sourceItemId: string;
  canonicalSuccessDetailId: string;
  locale: string;
  currency: string;
  title: string;
  description: string;
  attributes: Array<{ name: string; value: string }>;
  itemNumber: string | null;
  priceMinor: string;
  priceCurrency: string;
  stock: number;
  weightKg: string;
  dimensions: { lengthCm: string; widthCm: string; heightCm: string } | null;
  skus: Array<{
    skuId: string;
    attributes: Record<string, string>;
    priceMinor: string;
    priceCurrency: string;
    stock: number;
    assetIds: string[];
  }>;
  state: string;
  createdAt: Date;
}

// A single, frozen pool type signature that consumers can grab to type their own helpers.
export type DbPool = Pool;
