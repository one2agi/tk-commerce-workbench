import { strict as assert } from "node:assert";
import { isDeepStrictEqual } from "node:util";

import type {
  ApprovalSnapshotV1,
  ConfirmMiaoshouEditV1,
  MiaoshouSourceCollectResult
} from "@tk/contracts";
import { createApprovalSnapshot, type ApprovalSnapshotMaterial } from "@tk/domain";
import type { PoolClient } from "pg";

import { schema, type DbPool } from "../schema/index.js";
import { appendAuditInTransaction } from "./audit-repository.js";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function equalOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ConfirmResult {
  approvalSnapshotId: string;
  syncId: string;
}

export interface ApprovalConflictMetadata {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ApprovalSyncFence {
  jobId: string;
  owner: string;
  leaseToken: string;
}

export class ApprovalConflictError extends Error {
  readonly code = "approval_conflict";

  constructor(readonly metadata: ApprovalConflictMetadata) {
    super(`Approval material changed at ${metadata.field}`);
    this.name = "ApprovalConflictError";
  }
}

export class ApprovalSyncInProgressError extends Error {
  readonly code = "approval_sync_in_progress";

  constructor(readonly metadata: { approvalSnapshotId: string; syncState: string | null; jobStatus: string | null }) {
    super("Approval cannot be invalidated while Miaoshou synchronization is in progress");
    this.name = "ApprovalSyncInProgressError";
  }
}

export class MiaoshouRetryConflictError extends Error {
  constructor(readonly code: "retry_not_allowed" | "revision_changed" | "writeback_in_progress") {
    super(code);
    this.name = "MiaoshouRetryConflictError";
  }
}

/** Kept as a compatibility export for callers compiled against Wave 1. */
export class ApprovalNotReadyError extends Error {
  readonly code = "approval_mapping_not_ready";

  constructor() {
    super("Approval material is incomplete; no snapshot or Miaoshou job was created");
    this.name = "ApprovalNotReadyError";
  }
}

function conflict(field: string, expected: unknown, actual: unknown): never {
  throw new ApprovalConflictError({ field, expected, actual });
}

interface LockedProduct {
  id: string;
  source_url: string;
  source_item_id: string | null;
  canonical_success_detail_id: string | null;
  locale: string;
  currency: string;
  state_automation: string;
}

interface LockedRevision {
  id: string;
  draft_version: number;
  source_payload: Record<string, unknown>;
  working_draft: Record<string, unknown>;
}

interface PersistedApprovalRow {
  id: string;
  product_id: string;
  revision_id: string;
  draft_version: number;
  listing_run_id: string;
  pricing_run_id: string | null;
  template_version: number;
  ordered_final_asset_ids: string[];
  source_platform: "1688";
  source_canonical_url: string;
  source_item_id: string;
  canonical_success_detail_id: string | null;
  locale: string;
  currency: string;
  title: string;
  description: string;
  attributes: Array<{ name: string; value: string }>;
  item_number: string | null;
  price_minor: string | null;
  price_currency: string | null;
  stock: number | null;
  weight_kg: string | null;
  dimensions: { lengthCm: string; widthCm: string; heightCm: string } | null;
  skus: ApprovalSnapshotV1["skus"];
  state: string;
  created_at: Date;
}

function snapshotFromRow(row: PersistedApprovalRow): ApprovalSnapshotV1 {
  assert(row.source_platform === "1688", "unsupported approval source platform");
  assert(row.state === "approved", "approval snapshot is not active");
  const material = {
    approvalSnapshotId: row.id,
    productId: row.product_id,
    revisionId: row.revision_id,
    draftVersion: row.draft_version,
    listingRunId: row.listing_run_id,
    pricingRunId: row.pricing_run_id,
    templateVersion: row.template_version,
    orderedFinalAssetIds: row.ordered_final_asset_ids ?? [],
    sourceCanonicalUrl: row.source_canonical_url,
    sourceItemId: row.source_item_id,
    canonicalSuccessDetailId: row.canonical_success_detail_id,
    locale: row.locale,
    currency: row.currency,
    title: row.title,
    description: row.description,
    attributes: row.attributes ?? [],
    itemNumber: row.item_number,
    priceWire: row.price_minor && row.price_currency ? { amountMinor: row.price_minor, currency: row.price_currency } : null,
    stock: row.stock,
    weightKg: row.weight_kg,
    dimensions: row.dimensions,
    skus: row.skus ?? [],
    createdAt: row.created_at.toISOString()
  } as unknown as ApprovalSnapshotMaterial;
  return createApprovalSnapshot(material);
}

function assertSameApprovedMaterial(existing: ApprovalSnapshotV1, current: ApprovalSnapshotV1): void {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["templateVersion", existing.templateVersion, current.templateVersion],
    ["orderedFinalAssetIds", existing.orderedFinalAssetIds, current.orderedFinalAssetIds],
    ["sourceCanonicalUrl", existing.sourceCanonicalUrl, current.sourceCanonicalUrl],
    ["sourceItemId", existing.sourceItemId, current.sourceItemId],
    ["locale", existing.locale, current.locale],
    ["currency", existing.currency, current.currency],
    ["title", existing.title, current.title],
    ["description", existing.description, current.description],
    ["attributes", existing.attributes, current.attributes],
    ["itemNumber", existing.itemNumber, current.itemNumber],
    ["stock", existing.stock, current.stock],
    ["dimensions", existing.dimensions, current.dimensions],
    ["skus", existing.skus, current.skus]
  ];
  for (const [field, expected, actual] of comparisons) {
    if (!isDeepStrictEqual(expected, actual)) conflict(field, expected, actual);
  }
}

export class ApprovalRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  private async loadMaterial(client: PoolClient, command: ConfirmMiaoshouEditV1) {
    const productResult = await client.query<LockedProduct>(
      `SELECT id, source_url, source_item_id, canonical_success_detail_id, locale, currency, state_automation
       FROM ${schema.products} WHERE id = $1 FOR UPDATE`,
      [command.productId]
    );
    const product = productResult.rows[0];
    if (!product) conflict("productId", command.productId, null);
    if (product.state_automation !== "ready") conflict("automationState", "ready", product.state_automation);

    const revisionResult = await client.query<LockedRevision>(
      `SELECT id, draft_version, source_payload, working_draft
       FROM ${schema.productRevisions}
       WHERE product_id = $1
       ORDER BY draft_version DESC
       LIMIT 1 FOR UPDATE`,
      [command.productId]
    );
    const revision = revisionResult.rows[0];
    if (!revision) conflict("draftVersion", command.expectedDraftVersion, null);
    if (revision.draft_version !== command.expectedDraftVersion) {
      conflict("draftVersion", command.expectedDraftVersion, revision.draft_version);
    }

    const draft = object(revision.working_draft);
    const templateMatch = object(draft.templateMatch);
    const templateVersion = Number(templateMatch.templateVersion ?? 0);
    if (templateVersion !== command.expectedTemplateVersion) {
      conflict("templateVersion", command.expectedTemplateVersion, templateVersion || null);
    }
    const currentAssetOrder = stringArray(draft.finalAssetOrder);
    if (!equalOrder(currentAssetOrder, command.orderedFinalAssetIds)) {
      conflict("orderedFinalAssetIds", command.orderedFinalAssetIds, currentAssetOrder);
    }

    const listingResult = await client.query<{
      id: string;
      target_locale: string;
      title: string | null;
      description: string | null;
      attributes: Array<{ name: string; value: string }>;
    }>(
      `SELECT id, target_locale, title, description, attributes
       FROM ${schema.listingDrafts}
       WHERE id = $1 AND product_id = $2 AND revision_id = $3 AND draft_version = $4`,
      [command.expectedListingRunId, command.productId, revision.id, revision.draft_version]
    );
    const listing = listingResult.rows[0];
    if (!listing) conflict("listingRunId", command.expectedListingRunId, null);

    const assetsResult = await client.query<{ id: string; remote_url: string }>(
      `SELECT id, remote_url FROM ${schema.assets}
       WHERE revision_id = $1 AND state = 'ready' AND local_path IS NOT NULL`,
      [revision.id]
    );
    const assetsById = new Map(assetsResult.rows.map((asset) => [asset.id, asset]));
    const invalidAssetId = command.orderedFinalAssetIds.find((assetId) => !assetsById.has(assetId));
    if (invalidAssetId) conflict("orderedFinalAssetIds", command.orderedFinalAssetIds, { invalidAssetId });

    // New headless outputs must come from succeeded, non-excluded slots. Keep
    // completed legacy Canvas outputs eligible so already-running Canvas work can
    // still be approved during the headless migration.
    const provenanceResult = await client.query<{ asset_id: string }>(
      `SELECT archived_asset_id AS asset_id
       FROM ${schema.imageGenerationSlots}
       WHERE archived_asset_id = ANY($1::text[])
         AND state = 'succeeded'
         AND archived_asset_id IS NOT NULL
         AND excluded_at IS NULL
       UNION
       SELECT output.asset_id
       FROM ${schema.canvasRuns} canvas
       CROSS JOIN LATERAL jsonb_array_elements_text(canvas.outputs) AS output(asset_id)
       WHERE canvas.revision_id = $2
         AND canvas.state IN ('succeeded', 'partial')
         AND output.asset_id = ANY($1::text[])`,
      [command.orderedFinalAssetIds, revision.id]
    );
    const producedAssetIds = new Set(provenanceResult.rows.map((row) => row.asset_id));
    const unbackedAssetId = command.orderedFinalAssetIds.find((assetId) => !producedAssetIds.has(assetId));
    if (unbackedAssetId) {
      conflict("orderedFinalAssetIds", command.orderedFinalAssetIds, { unbackedAssetId });
    }

    return { product, revision, listing, assetsById, templateVersion };
  }

  async confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<ConfirmResult> {
    assert(command.version === 1, "ConfirmMiaoshouEditV1 version must be 1");
    assert(command.productId.length > 0, "productId required");
    assert(command.orderedFinalAssetIds.length > 0, "orderedFinalAssetIds required");
    assert(new Set(command.orderedFinalAssetIds).size === command.orderedFinalAssetIds.length, "orderedFinalAssetIds must be unique");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const material = await this.loadMaterial(client, command);
      const source = object(material.revision.source_payload);
      const sourceItemId = material.product.source_item_id ?? String(source.sourceItemId ?? "");
      const canonicalSuccessDetailId = material.product.canonical_success_detail_id;
      if (!sourceItemId) conflict("sourceItemId", "known", null);

      const assetsByRemoteUrl = new Map(
        [...material.assetsById.values()].map((asset) => [asset.remote_url, asset.id])
      );
      const skus = (Array.isArray(source.skus) ? source.skus : []).map((raw) => {
        const sku = object(raw);
        const imageAssetId = typeof sku.imageUrl === "string" ? assetsByRemoteUrl.get(sku.imageUrl) : undefined;
        return {
          skuId: String(sku.skuId ?? ""),
          attributes: object(sku.attributes) as Record<string, string>,
          stock: Number.isInteger(Number(sku.stock)) ? Number(sku.stock) : null,
          assetIds: imageAssetId ? [imageAssetId] : []
        };
      });
      const dimensions = object(source.dimensionsCm);
      const normalizedDimensions = [dimensions.lengthCm, dimensions.widthCm, dimensions.heightCm].every((part) => typeof part === "string")
        ? { lengthCm: String(dimensions.lengthCm), widthCm: String(dimensions.widthCm), heightCm: String(dimensions.heightCm) }
        : null;
      const approvalSnapshotId = newId("approval");
      const syncId = newId("sync");
      const createdAt = new Date().toISOString();
      const snapshot = {
        approvalSnapshotId,
        productId: command.productId,
        revisionId: material.revision.id,
        draftVersion: material.revision.draft_version,
        listingRunId: material.listing.id,
        pricingRunId: null,
        templateVersion: material.templateVersion,
        orderedFinalAssetIds: [...command.orderedFinalAssetIds],
        sourcePlatform: "1688",
        sourceCanonicalUrl: material.product.source_url,
        sourceItemId,
        canonicalSuccessDetailId,
        locale: material.listing.target_locale || material.product.locale,
        currency: material.product.currency,
        title: material.listing.title ?? "",
        description: material.listing.description ?? "",
        attributes: Array.isArray(material.listing.attributes) ? material.listing.attributes : [],
        itemNumber: typeof source.itemNumber === "string" ? source.itemNumber : null,
        priceWire: null,
        stock: null,
        weightKg: null,
        dimensions: normalizedDimensions,
        skus,
        createdAt
      } as unknown as ApprovalSnapshotV1;

      const existingResult = await client.query<PersistedApprovalRow & { sync_id: string }>(
        `SELECT approval.*, sync.id AS sync_id
         FROM ${schema.approvalSnapshots} approval
         JOIN ${schema.miaoshouSyncs} sync ON sync.approval_snapshot_id = approval.id
         WHERE approval.product_id = $1 AND approval.revision_id = $2
           AND approval.draft_version = $3 AND approval.listing_run_id = $4
           AND approval.pricing_run_id IS NOT DISTINCT FROM $5
         FOR UPDATE`,
        [command.productId, material.revision.id, command.expectedDraftVersion, command.expectedListingRunId, null]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.state !== "approved") conflict("approvalState", "approved", existing.state);
        assertSameApprovedMaterial(snapshotFromRow(existing), snapshot);
        await client.query("COMMIT");
        return { approvalSnapshotId: existing.id, syncId: existing.sync_id };
      }

      await client.query(
        `INSERT INTO ${schema.approvalSnapshots}
         (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
          template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
          source_item_id, canonical_success_detail_id, locale, currency, title, description,
          attributes, item_number, price_minor, price_currency, stock, weight_kg, dimensions, skus, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23::jsonb,
                 $24::jsonb, 'approved', $25::timestamptz)`,
        [
          snapshot.approvalSnapshotId, snapshot.productId, snapshot.revisionId, snapshot.draftVersion,
          snapshot.listingRunId, snapshot.pricingRunId, snapshot.templateVersion,
          JSON.stringify(snapshot.orderedFinalAssetIds), snapshot.sourcePlatform, snapshot.sourceCanonicalUrl,
          snapshot.sourceItemId, snapshot.canonicalSuccessDetailId, snapshot.locale, snapshot.currency,
          snapshot.title, snapshot.description, JSON.stringify(snapshot.attributes), snapshot.itemNumber,
          null, null, null, null,
          JSON.stringify(snapshot.dimensions), JSON.stringify(snapshot.skus), snapshot.createdAt
        ]
      );
      await client.query(
        `INSERT INTO ${schema.miaoshouSyncs} (id, approval_snapshot_id, state)
         VALUES ($1, $2, 'queued')`,
        [syncId, approvalSnapshotId]
      );
      const writebackJobKind = canonicalSuccessDetailId
        ? "miaoshou_edit"
        : "miaoshou_prepare_writeback";
      const writebackBusinessKey = canonicalSuccessDetailId
        ? `miaoshou-edit:${approvalSnapshotId}`
        : `miaoshou-prepare:${approvalSnapshotId}`;
      const writebackPayload = canonicalSuccessDetailId
        ? {
            version: 1,
            approvalSnapshotId,
            productId: command.productId,
            canonicalSuccessDetailId
          }
        : {
            version: 1,
            approvalSnapshotId,
            productId: command.productId,
            revisionId: material.revision.id,
            sourceUrl: material.product.source_url,
            idempotencyKey: writebackBusinessKey
          };
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, $2, $3, $3, $4::jsonb, 'queued', 3)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [newId("job"), writebackJobKind, writebackBusinessKey, JSON.stringify(writebackPayload)]
      );
      await client.query(
        `UPDATE ${schema.products}
         SET state_approval = 'approved', state_miaoshou_edit = 'queued', updated_at = now()
         WHERE id = $1`,
        [command.productId]
      );
      await appendAuditInTransaction(client, {
        actorType: "operator",
        action: "approval.confirmed",
        targetKind: "approval_snapshot",
        payload: {
          productId: command.productId,
          draftVersion: command.expectedDraftVersion,
          listingRunId: command.expectedListingRunId,
          pricingRunId: null,
          templateVersion: command.expectedTemplateVersion,
          assetCount: command.orderedFinalAssetIds.length
        }
      }, approvalSnapshotId);
      await client.query("COMMIT");
      return { approvalSnapshotId, syncId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async bindCanonicalAndEnqueueEdit(
    value: {
      approvalSnapshotId: string;
      productId: string;
      result: MiaoshouSourceCollectResult;
    },
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        product_id: string;
        source_item_id: string;
        approval_state: string;
      }>(
        `SELECT approval.product_id, approval.source_item_id,
                approval.state AS approval_state
         FROM ${schema.approvalSnapshots} approval
         JOIN ${schema.products} product ON product.id = approval.product_id
         WHERE approval.id = $1 AND approval.product_id = $2
         FOR UPDATE OF approval, product`,
        [value.approvalSnapshotId, value.productId]
      );
      const material = locked.rows[0];
      if (!material || material.approval_state !== "approved") {
        await client.query("ROLLBACK");
        return false;
      }
      const owned = await client.query(
        `SELECT id FROM ${schema.jobs}
         WHERE id = $1
           AND kind = 'miaoshou_prepare_writeback'
           AND status = 'running'
           AND owner = $2
           AND lease_token = $3
           AND lease_expires_at > now()
           AND payload->>'approvalSnapshotId' = $4
         FOR UPDATE`,
        [fence.jobId, fence.owner, fence.leaseToken, value.approvalSnapshotId]
      );
      if ((owned.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      const canonicalSuccessDetailId = value.result.canonicalSuccessDetailId;
      await client.query(
        `UPDATE ${schema.products}
         SET canonical_success_detail_id = $2,
             state_source = 'success',
             state_miaoshou_edit = 'queued',
             updated_at = now()
         WHERE id = $1`,
        [value.productId, canonicalSuccessDetailId]
      );
      await client.query(
        `UPDATE ${schema.approvalSnapshots}
         SET canonical_success_detail_id = $2
         WHERE id = $1`,
        [value.approvalSnapshotId, canonicalSuccessDetailId]
      );
      await client.query(
        `INSERT INTO ${schema.miaoshouSourceRecords}
          (id, product_id, source_item_id, fetch_detail_id, skipped_detail_id,
           canonical_success_detail_id, fetched_payload, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          newId("source"),
          value.productId,
          material.source_item_id,
          value.result.fetchDetailId,
          value.result.skippedDetailId,
          canonicalSuccessDetailId,
          JSON.stringify(value.result),
          value.result.skippedDetailId ? "skipped_duplicate" : "success"
        ]
      );
      const businessKey = `miaoshou-edit:${value.approvalSnapshotId}`;
      await client.query(
        `INSERT INTO ${schema.jobs}
          (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, 'miaoshou_edit', $2, $2, $3::jsonb, 'queued', 3)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [
          newId("job"),
          businessKey,
          JSON.stringify({
            version: 1,
            approvalSnapshotId: value.approvalSnapshotId,
            productId: value.productId,
            canonicalSuccessDetailId
          })
        ]
      );
      await appendAuditInTransaction(client, {
        actorType: "worker",
        action: "miaoshou.prepare_writeback.bound",
        targetKind: "approval_snapshot",
        payload: {
          productId: value.productId,
          canonicalSuccessDetailId
        }
      }, value.approvalSnapshotId);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async invalidateForProductInTransaction(
    client: PoolClient,
    productId: string,
    reason: string
  ): Promise<boolean> {
    assert(productId.length > 0, "productId required");
    assert(reason.length > 0, "invalidation reason required");
    // Global lock order for approval mutations: product -> approval -> sync -> job.
    const product = await client.query<{ id: string }>(
      `SELECT id FROM ${schema.products} WHERE id = $1 FOR UPDATE`,
      [productId]
    );
    assert(product.rows[0], "product not found");
    const current = await client.query<{ id: string }>(
      `SELECT id FROM ${schema.approvalSnapshots}
       WHERE product_id = $1 AND state = 'approved'
       ORDER BY created_at DESC, id DESC
       LIMIT 1 FOR UPDATE`,
      [productId]
    );
    const approvalSnapshotId = current.rows[0]?.id;
    if (!approvalSnapshotId) return false;

    const sync = await client.query<{ state: string }>(
      `SELECT state FROM ${schema.miaoshouSyncs}
       WHERE approval_snapshot_id = $1 FOR UPDATE`,
      [approvalSnapshotId]
    );
    const editJobs = await client.query<{ status: string }>(
      `SELECT status FROM ${schema.jobs}
       WHERE kind = 'miaoshou_edit' AND payload->>'approvalSnapshotId' = $1
       ORDER BY id FOR UPDATE`,
      [approvalSnapshotId]
    );
    const syncState = sync.rows[0]?.state ?? null;
    const runningJob = editJobs.rows.find((row) => row.status === "running");
    if (runningJob || syncState === "syncing" || syncState === "result_unknown") {
      throw new ApprovalSyncInProgressError({
        approvalSnapshotId,
        syncState,
        jobStatus: runningJob?.status ?? editJobs.rows[0]?.status ?? null
      });
    }

    await client.query(
      `UPDATE ${schema.approvalSnapshots} SET state = 'invalidated'
       WHERE id = $1 AND state = 'approved'`,
      [approvalSnapshotId]
    );
    await client.query(
      `UPDATE ${schema.products}
       SET state_approval = 'unapproved', updated_at = now()
       WHERE id = $1`,
      [productId]
    );
    await client.query(
      `UPDATE ${schema.jobs}
       SET status = 'failed',
           error = $2::jsonb,
           owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           updated_at = now()
       WHERE kind = 'miaoshou_edit'
         AND payload->>'approvalSnapshotId' = $1
         AND status IN ('queued', 'paused')`,
      [approvalSnapshotId, JSON.stringify({ code: "approval_invalidated", safeMessage: "Approval changed before Miaoshou sync" })]
    );
    await client.query(
      `UPDATE ${schema.miaoshouSyncs}
       SET state = 'failed', error = $2::jsonb, updated_at = now()
       WHERE approval_snapshot_id = $1 AND state = 'queued'`,
      [approvalSnapshotId, JSON.stringify({ code: "approval_invalidated", safeMessage: "Approval changed before Miaoshou sync" })]
    );
    await appendAuditInTransaction(client, {
      actorType: "operator",
      action: "approval.invalidated",
      targetKind: "approval_snapshot",
      payload: { productId, reason }
    }, approvalSnapshotId);
    return true;
  }

  async invalidateCurrentApproval(productId: string, reason: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invalidated = await this.invalidateForProductInTransaction(client, productId, reason);
      await client.query("COMMIT");
      return invalidated;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async retryMiaoshouEditAfterNoChange(productId: string): Promise<{
    approvalSnapshotId: string;
    syncId: string;
    jobId: string;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const productResult = await client.query<{
        id: string;
        current_revision_id: string;
        current_draft_version: number;
      }>(
        `SELECT product.id,
                revision.id AS current_revision_id,
                revision.draft_version AS current_draft_version
         FROM ${schema.products} product
         JOIN LATERAL (
           SELECT candidate.id, candidate.draft_version
           FROM ${schema.productRevisions} candidate
           WHERE candidate.product_id = product.id
           ORDER BY candidate.draft_version DESC, candidate.created_at DESC
           LIMIT 1
         ) revision ON true
         WHERE product.id = $1
         FOR UPDATE OF product`,
        [productId]
      );
      const product = productResult.rows[0];
      if (!product) throw new MiaoshouRetryConflictError("retry_not_allowed");

      const approvalResult = await client.query<{
        id: string;
        revision_id: string;
        draft_version: number;
        canonical_success_detail_id: string | null;
      }>(
        `SELECT id, revision_id, draft_version, canonical_success_detail_id
         FROM ${schema.approvalSnapshots}
         WHERE product_id = $1 AND state = 'approved'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [productId]
      );
      const approval = approvalResult.rows[0];
      if (!approval?.canonical_success_detail_id) {
        throw new MiaoshouRetryConflictError("retry_not_allowed");
      }
      if (
        approval.revision_id !== product.current_revision_id ||
        approval.draft_version !== Number(product.current_draft_version)
      ) {
        throw new MiaoshouRetryConflictError("revision_changed");
      }

      const syncResult = await client.query<{ id: string; state: string; error: unknown }>(
        `SELECT id, state, error
         FROM ${schema.miaoshouSyncs}
         WHERE approval_snapshot_id = $1
         FOR UPDATE`,
        [approval.id]
      );
      const sync = syncResult.rows[0];
      if (!sync) throw new MiaoshouRetryConflictError("retry_not_allowed");

      const existingRetry = await client.query<{ id: string }>(
        `SELECT id
         FROM ${schema.jobs}
         WHERE kind = 'miaoshou_edit'
           AND payload->>'approvalSnapshotId' = $1
           AND left(business_key, length($2)) = $2
           AND status IN ('queued', 'running')
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [approval.id, `miaoshou-edit:${approval.id}:manual-retry:`]
      );
      if (existingRetry.rows[0]) {
        await client.query("COMMIT");
        return {
          approvalSnapshotId: approval.id,
          syncId: sync.id,
          jobId: existingRetry.rows[0].id
        };
      }

      const syncError = object(sync.error);
      const reconciliation = object(syncError.reconciliation);
      const explicitNoChange = syncError.code === "miaoshou_reconcile_no_change"
        || reconciliation.state === "no_change";
      if (sync.state !== "result_unknown" || !explicitNoChange) {
        throw new MiaoshouRetryConflictError("retry_not_allowed");
      }

      const activeJob = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.jobs}
         WHERE kind = 'miaoshou_edit'
           AND payload->>'approvalSnapshotId' = $1
           AND status IN ('queued', 'running')
         LIMIT 1
         FOR UPDATE`,
        [approval.id]
      );
      if (activeJob.rows[0]) throw new MiaoshouRetryConflictError("writeback_in_progress");

      const previousJobResult = await client.query<{
        id: string;
        status: string;
        remote_task_id: string | null;
        error: unknown;
      }>(
        `SELECT id, status, remote_task_id, error
         FROM ${schema.jobs}
         WHERE kind = 'miaoshou_edit'
           AND payload->>'approvalSnapshotId' = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [approval.id]
      );
      const previousJob = previousJobResult.rows[0];
      if (
        previousJob?.status !== "needs_input" ||
        !previousJob.remote_task_id ||
        object(previousJob.error).code !== "reconcile_failed"
      ) {
        throw new MiaoshouRetryConflictError("retry_not_allowed");
      }

      const retryCountResult = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM ${schema.jobs}
         WHERE kind = 'miaoshou_edit'
           AND payload->>'approvalSnapshotId' = $1
           AND left(business_key, length($2)) = $2`,
        [approval.id, `miaoshou-edit:${approval.id}:manual-retry:`]
      );
      const retrySequence = Number(retryCountResult.rows[0]?.count ?? 0) + 1;
      const jobId = newId("job");
      const businessKey = `miaoshou-edit:${approval.id}:manual-retry:${retrySequence}`;
      const payload = {
        version: 1,
        approvalSnapshotId: approval.id,
        productId,
        canonicalSuccessDetailId: approval.canonical_success_detail_id,
        manualRetrySequence: retrySequence
      };
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, 'miaoshou_edit', $2, $2, $3::jsonb, 'queued', 3)`,
        [jobId, businessKey, JSON.stringify(payload)]
      );
      await client.query(
        `UPDATE ${schema.miaoshouSyncs}
         SET state = 'queued',
             error = COALESCE(error, '{}'::jsonb) || jsonb_build_object(
               'manualRetry', jsonb_build_object(
                 'sequence', $2::integer,
                 'queuedAt', to_jsonb(now()),
                 'previousJobId', $3::text
               )
             ),
             updated_at = now()
         WHERE id = $1`,
        [sync.id, retrySequence, previousJob.id]
      );
      await client.query(
        `UPDATE ${schema.products}
         SET state_miaoshou_edit = 'queued', updated_at = now()
         WHERE id = $1`,
        [productId]
      );
      const initialFailure = object(syncError.initialFailure);
      await appendAuditInTransaction(client, {
        actorType: "operator",
        action: "miaoshou.edit.manual_retry_queued",
        targetKind: "approval_snapshot",
        payload: {
          productId,
          previousJobId: previousJob.id,
          newJobId: jobId,
          retrySequence,
          previousFailureCode: String(initialFailure.code ?? syncError.code ?? "unknown")
        }
      }, approval.id);
      await client.query("COMMIT");
      return { approvalSnapshotId: approval.id, syncId: sync.id, jobId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadSnapshot(approvalSnapshotId: string): Promise<ApprovalSnapshotV1> {
    const result = await this.pool.query<PersistedApprovalRow>(
      `SELECT * FROM ${schema.approvalSnapshots} WHERE id = $1`,
      [approvalSnapshotId]
    );
    const row = result.rows[0];
    assert(row, "approval snapshot not found");
    const snapshot = snapshotFromRow(row);
    const assets = snapshot.orderedFinalAssetIds.length === 0
      ? { rows: [] }
      : await this.pool.query<{ id: string; local_path: string; sha256: string | null; extension: string | null }>(
          `SELECT id, local_path, sha256, extension FROM ${schema.assets}
           WHERE revision_id = $1 AND id = ANY($2::text[]) AND state = 'ready' AND local_path IS NOT NULL`,
          [snapshot.revisionId, snapshot.orderedFinalAssetIds]
        );
    const pathsById = new Map(assets.rows.map((asset) => [asset.id, asset.local_path]));
    const sha256ById = new Map(assets.rows.map((asset) => [asset.id, asset.sha256]));
    const extensionById = new Map(assets.rows.map((asset) => [asset.id, asset.extension]));
    const { sourcePlatform: _sourcePlatform, ...material } = snapshot;
    return createApprovalSnapshot({
      ...material,
      orderedFinalAssetLocalPaths: snapshot.orderedFinalAssetIds.flatMap((assetId) =>
        pathsById.has(assetId) ? [pathsById.get(assetId)!] : []
      ),
      orderedFinalAssetSha256: snapshot.orderedFinalAssetIds.flatMap((assetId) => {
        const value = sha256ById.get(assetId);
        return value ? [value] : [];
      }),
      orderedFinalAssetExtension: snapshot.orderedFinalAssetIds.flatMap((assetId) => {
        const value = extensionById.get(assetId);
        return value ? [value] : [];
      })
    });
  }

  private async withSyncFence(
    approvalSnapshotId: string,
    fence: ApprovalSyncFence,
    action: string,
    payload: Record<string, unknown>,
    operation: (client: PoolClient) => Promise<boolean>
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Match invalidation lock order so a UI edit racing a Worker terminal write
      // serializes cleanly instead of invalidating material still being sent remotely.
      const product = await client.query(
        `SELECT product.id
         FROM ${schema.products} product
         JOIN ${schema.approvalSnapshots} approval ON approval.product_id = product.id
         WHERE approval.id = $1
         FOR UPDATE OF product`,
        [approvalSnapshotId]
      );
      if ((product.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      const approval = await client.query<{ state: string }>(
        `SELECT state FROM ${schema.approvalSnapshots} WHERE id = $1 FOR UPDATE`,
        [approvalSnapshotId]
      );
      if (approval.rows[0]?.state !== "approved") {
        await client.query("ROLLBACK");
        return false;
      }
      const sync = await client.query(
        `SELECT id FROM ${schema.miaoshouSyncs}
         WHERE approval_snapshot_id = $1 FOR UPDATE`,
        [approvalSnapshotId]
      );
      if ((sync.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      const owned = await client.query(
        `SELECT id FROM ${schema.jobs}
         WHERE id = $1 AND kind = 'miaoshou_edit' AND status = 'running'
           AND owner = $2 AND lease_token = $3 AND lease_expires_at > now()
           AND payload->>'approvalSnapshotId' = $4
         FOR UPDATE`,
        [fence.jobId, fence.owner, fence.leaseToken, approvalSnapshotId]
      );
      if ((owned.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      const changed = await operation(client);
      if (!changed) {
        await client.query("ROLLBACK");
        return false;
      }
      await appendAuditInTransaction(client, {
        actorType: "worker",
        action,
        targetKind: "approval_snapshot",
        payload
      }, approvalSnapshotId);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSucceeded(
    approvalSnapshotId: string,
    remoteDetailId: string,
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    return this.withSyncFence(
      approvalSnapshotId,
      fence,
      "miaoshou.edit.persisted",
      { state: "succeeded", remoteDetailId },
      async (client) => {
        const updated = await client.query(
          `UPDATE ${schema.miaoshouSyncs}
           SET state = 'succeeded', remote_detail_id = $2, error = NULL, updated_at = now()
           WHERE approval_snapshot_id = $1 AND state IN ('queued', 'syncing', 'result_unknown')`,
          [approvalSnapshotId, remoteDetailId]
        );
        if ((updated.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE ${schema.products} SET state_miaoshou_edit = 'succeeded', updated_at = now()
           WHERE id = (SELECT product_id FROM ${schema.approvalSnapshots} WHERE id = $1)`,
          [approvalSnapshotId]
        );
        return true;
      }
    );
  }

  async saveValidationFailure(
    approvalSnapshotId: string,
    fieldErrors: Array<{ fieldPath: string; message: string }>,
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    const error = {
      kind: "fatal",
      code: "miaoshou_validation_failed",
      safeMessage: "Miaoshou rejected approved fields",
      fieldErrors
    };
    return this.withSyncFence(
      approvalSnapshotId,
      fence,
      "miaoshou.edit.validation_failed",
      { state: "failed", fieldErrorCount: fieldErrors.length },
      async (client) => {
        const updated = await client.query(
          `UPDATE ${schema.miaoshouSyncs}
           SET state = 'failed', error = $2::jsonb, updated_at = now()
           WHERE approval_snapshot_id = $1 AND state IN ('queued', 'syncing', 'result_unknown')`,
          [approvalSnapshotId, JSON.stringify(error)]
        );
        if ((updated.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE ${schema.products} SET state_miaoshou_edit = 'failed', updated_at = now()
           WHERE id = (SELECT product_id FROM ${schema.approvalSnapshots} WHERE id = $1)`,
          [approvalSnapshotId]
        );
        return true;
      }
    );
  }

  async saveResultUnknown(
    approvalSnapshotId: string,
    failure: Record<string, unknown>,
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    return this.withSyncFence(
      approvalSnapshotId,
      fence,
      "miaoshou.edit.result_unknown",
      { state: "result_unknown", code: String(failure.code ?? "reconcile_required") },
      async (client) => {
        const updated = await client.query(
          `UPDATE ${schema.miaoshouSyncs}
           SET state = 'result_unknown', error = $2::jsonb, updated_at = now()
           WHERE approval_snapshot_id = $1 AND state IN ('queued', 'syncing', 'result_unknown')`,
          [approvalSnapshotId, JSON.stringify(failure)]
        );
        if ((updated.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE ${schema.products} SET state_miaoshou_edit = 'result_unknown', updated_at = now()
           WHERE id = (SELECT product_id FROM ${schema.approvalSnapshots} WHERE id = $1)`,
          [approvalSnapshotId]
        );
        return true;
      }
    );
  }

  async saveReconciliationResultUnknown(
    approvalSnapshotId: string,
    result: { remoteDetailId: string; state: "no_change" | "missing" },
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    const code = `miaoshou_reconcile_${result.state}`;
    return this.withSyncFence(
      approvalSnapshotId,
      fence,
      "miaoshou.edit.reconciliation_result_unknown",
      { state: result.state, code, remoteDetailId: result.remoteDetailId },
      async (client) => {
        const updated = await client.query(
          `UPDATE ${schema.miaoshouSyncs}
           SET state = 'result_unknown', last_reconciled_at = now(),
               error = jsonb_build_object(
                 'kind', 'reconcile_required',
                 'code', $2::text,
                 'safeMessage', 'Miaoshou reconciliation did not prove the approved edit was applied',
                 'initialFailure', CASE
                   WHEN jsonb_typeof(error->'initialFailure') = 'object' THEN error->'initialFailure'
                   WHEN jsonb_typeof(error) = 'object' THEN error
                   ELSE jsonb_build_object(
                     'kind', 'reconcile_required',
                     'code', 'miaoshou.edit_result_unknown',
                     'safeMessage', 'Miaoshou edit result is unknown and must be reconciled'
                   )
                 END,
                 'reconciliation', jsonb_build_object(
                   'state', $3::text,
                   'remoteDetailId', $4::text,
                   'checkedAt', to_jsonb(now())
                 )
               ),
               updated_at = now()
           WHERE approval_snapshot_id = $1 AND state = 'result_unknown'`,
          [approvalSnapshotId, code, result.state, result.remoteDetailId]
        );
        if ((updated.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE ${schema.products} SET state_miaoshou_edit = 'result_unknown', updated_at = now()
           WHERE id = (SELECT product_id FROM ${schema.approvalSnapshots} WHERE id = $1)`,
          [approvalSnapshotId]
        );
        return true;
      }
    );
  }

  async saveReconciled(
    approvalSnapshotId: string,
    result: { remoteDetailId: string; state: "applied" | "no_change" | "missing" },
    fence: ApprovalSyncFence
  ): Promise<boolean> {
    if (result.state !== "applied") return false;
    return this.withSyncFence(
      approvalSnapshotId,
      fence,
      "miaoshou.edit.reconciled",
      { state: "applied", remoteDetailId: result.remoteDetailId },
      async (client) => {
        const updated = await client.query(
          `UPDATE ${schema.miaoshouSyncs}
           SET state = 'succeeded', remote_detail_id = $2, last_reconciled_at = now(),
               error = NULL, updated_at = now()
           WHERE approval_snapshot_id = $1 AND state = 'result_unknown'`,
          [approvalSnapshotId, result.remoteDetailId]
        );
        if ((updated.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE ${schema.products} SET state_miaoshou_edit = 'succeeded', updated_at = now()
           WHERE id = (SELECT product_id FROM ${schema.approvalSnapshots} WHERE id = $1)`,
          [approvalSnapshotId]
        );
        return true;
      }
    );
  }
}
