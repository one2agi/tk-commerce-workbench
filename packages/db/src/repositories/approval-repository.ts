import { strict as assert } from "node:assert";
import { isDeepStrictEqual } from "node:util";

import type { ApprovalSnapshotV1, ConfirmMiaoshouEditV1 } from "@tk/contracts";
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
  pricing_run_id: string;
  template_version: number;
  ordered_final_asset_ids: string[];
  source_platform: "1688";
  source_canonical_url: string;
  source_item_id: string;
  canonical_success_detail_id: string;
  locale: string;
  currency: string;
  title: string;
  description: string;
  attributes: Array<{ name: string; value: string }>;
  item_number: string | null;
  price_minor: string;
  price_currency: string;
  stock: number;
  weight_kg: string;
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
    priceWire: { amountMinor: row.price_minor, currency: row.price_currency },
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
    ["canonicalSuccessDetailId", existing.canonicalSuccessDetailId, current.canonicalSuccessDetailId],
    ["locale", existing.locale, current.locale],
    ["currency", existing.currency, current.currency],
    ["title", existing.title, current.title],
    ["description", existing.description, current.description],
    ["attributes", existing.attributes, current.attributes],
    ["itemNumber", existing.itemNumber, current.itemNumber],
    ["priceWire", existing.priceWire, current.priceWire],
    ["stock", existing.stock, current.stock],
    ["weightKg", existing.weightKg, current.weightKg],
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
    const currentListingRunId = String(draft.listingRunId ?? "");
    if (currentListingRunId !== command.expectedListingRunId) {
      conflict("listingRunId", command.expectedListingRunId, currentListingRunId || null);
    }
    const currentPricingRunId = String(draft.pricingRunId ?? "");
    if (currentPricingRunId !== command.expectedPricingRunId) {
      conflict("pricingRunId", command.expectedPricingRunId, currentPricingRunId || null);
    }
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

    const pricingResult = await client.query<{
      id: string;
      state: string;
      final_price_minor: string | null;
      final_currency: string | null;
    }>(
      `SELECT id, state, final_price_minor, final_currency
       FROM ${schema.pricingRuns}
       WHERE id = $1 AND product_id = $2 AND revision_id = $3 AND draft_version = $4`,
      [command.expectedPricingRunId, command.productId, revision.id, revision.draft_version]
    );
    const pricing = pricingResult.rows[0];
    if (!pricing || pricing.state !== "ready" || !pricing.final_price_minor || !pricing.final_currency) {
      conflict("pricingRunId", command.expectedPricingRunId, pricing?.state ?? null);
    }

    const assetsResult = await client.query<{ id: string; remote_url: string }>(
      `SELECT id, remote_url FROM ${schema.assets}
       WHERE revision_id = $1 AND state = 'ready' AND local_path IS NOT NULL`,
      [revision.id]
    );
    const assetsById = new Map(assetsResult.rows.map((asset) => [asset.id, asset]));
    const invalidAssetId = command.orderedFinalAssetIds.find((assetId) => !assetsById.has(assetId));
    if (invalidAssetId) conflict("orderedFinalAssetIds", command.orderedFinalAssetIds, { invalidAssetId });

    return { product, revision, listing, pricing, assetsById, templateVersion };
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
      const canonicalSuccessDetailId = material.product.canonical_success_detail_id ?? "";
      const stock = Number(source.sourceStock);
      const weightKg = typeof source.weightKg === "string" ? source.weightKg : "";
      if (!sourceItemId) conflict("sourceItemId", "known", null);
      if (!canonicalSuccessDetailId) conflict("canonicalSuccessDetailId", "known", null);
      if (!Number.isInteger(stock) || stock < 0) conflict("stock", "non-negative integer", source.sourceStock ?? null);
      if (!weightKg) conflict("weightKg", "known", null);

      const assetsByRemoteUrl = new Map(
        [...material.assetsById.values()].map((asset) => [asset.remote_url, asset.id])
      );
      const skus = (Array.isArray(source.skus) ? source.skus : []).map((raw) => {
        const sku = object(raw);
        const imageAssetId = typeof sku.imageUrl === "string" ? assetsByRemoteUrl.get(sku.imageUrl) : undefined;
        return {
          skuId: String(sku.skuId ?? ""),
          attributes: object(sku.attributes) as Record<string, string>,
          // The frozen edit payload must never mix source CNY with the target product
          // currency. The current pricing model produces one target listing price, so
          // every variant inherits that explicit approved target price.
          priceWire: {
            amountMinor: material.pricing.final_price_minor,
            currency: material.pricing.final_currency
          },
          stock: Number.isInteger(Number(sku.stock)) ? Number(sku.stock) : 0,
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
        pricingRunId: material.pricing.id,
        templateVersion: material.templateVersion,
        orderedFinalAssetIds: [...command.orderedFinalAssetIds],
        sourcePlatform: "1688",
        sourceCanonicalUrl: material.product.source_url,
        sourceItemId,
        canonicalSuccessDetailId,
        locale: material.listing.target_locale || material.product.locale,
        currency: material.pricing.final_currency,
        title: material.listing.title ?? "",
        description: material.listing.description ?? "",
        attributes: Array.isArray(material.listing.attributes) ? material.listing.attributes : [],
        itemNumber: typeof source.itemNumber === "string" ? source.itemNumber : null,
        priceWire: { amountMinor: material.pricing.final_price_minor, currency: material.pricing.final_currency },
        stock,
        weightKg,
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
           AND approval.pricing_run_id = $5
         FOR UPDATE`,
        [command.productId, material.revision.id, command.expectedDraftVersion, command.expectedListingRunId, command.expectedPricingRunId]
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
          snapshot.priceWire.amountMinor, snapshot.priceWire.currency, snapshot.stock, snapshot.weightKg,
          JSON.stringify(snapshot.dimensions), JSON.stringify(snapshot.skus), snapshot.createdAt
        ]
      );
      await client.query(
        `INSERT INTO ${schema.miaoshouSyncs} (id, approval_snapshot_id, state)
         VALUES ($1, $2, 'queued')`,
        [syncId, approvalSnapshotId]
      );
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, 'miaoshou_edit', $2, $2, $3::jsonb, 'queued', 3)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [newId("job"), `miaoshou-edit:${approvalSnapshotId}`, JSON.stringify({
          version: 1,
          approvalSnapshotId,
          productId: command.productId,
          canonicalSuccessDetailId
        })]
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
          pricingRunId: command.expectedPricingRunId,
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

  async loadSnapshot(approvalSnapshotId: string): Promise<ApprovalSnapshotV1> {
    const result = await this.pool.query<PersistedApprovalRow>(
      `SELECT * FROM ${schema.approvalSnapshots} WHERE id = $1`,
      [approvalSnapshotId]
    );
    const row = result.rows[0];
    assert(row, "approval snapshot not found");
    return snapshotFromRow(row);
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
