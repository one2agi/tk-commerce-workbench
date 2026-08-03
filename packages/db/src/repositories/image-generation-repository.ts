// Image generation repository: template versions, batches, and independent slots.
//
// Provides transactional creation of batches with planner jobs, atomic slot state
// transitions, and idempotent re-entry via unique constraints.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import type { ImageGenerationRecipeV1, PlannedImagePromptV1, ResolvedImageReferenceV1 } from "@tk/contracts";
import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface CreateBatchInput {
  idempotencyKey: string;
  productId: string;
  revisionId: string;
  selectedAssetIds: string[];
  requestedOutputCount: number;
  categoryKey: string;
  templateId: string;
  templateVersionId: string;
  templateVersion: number;
  recipe: ImageGenerationRecipeV1;
  productFacts: Record<string, unknown>;
  productFactsDigest: string;
}

export interface CreateBatchResult {
  batchId: string;
  plannerJobId: string;
}

export interface LoadGenerationStartContextInput {
  productId: string;
  revisionId: string;
  selectedAssetIds: string[];
}

export interface LoadGenerationStartContextResult {
  productFacts: Record<string, unknown>;
}

function commandError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export interface SlotFence {
  jobId: string;
  owner: string;
  leaseToken: string;
}

export interface LoadPlanningContextResult {
  batchId: string;
  productId: string;
  revisionId: string;
  templateId: string;
  templateVersionId: string;
  recipe: ImageGenerationRecipeV1;
  references: ResolvedImageReferenceV1[];
  productFacts: Record<string, unknown>;
}

export interface SavePlanAndQueueSlotsInput {
  batchId: string;
  prompts: PlannedImagePromptV1[];
}

export interface LoadSlotExecutionResult {
  slotId: string;
  batchId: string;
  slotNumber: number;
  role: string;
  prompt: PlannedImagePromptV1 | null;
  state: string;
  attempt: number;
  remoteTaskId: string | null;
  remoteOutputUrl: string | null;
  error: unknown;
  references: ResolvedImageReferenceV1[];
  parameters: Readonly<Record<string, unknown>>;
}

export interface ArchivedImageOutput {
  remoteUrl: string;
  finalUrl: string;
  sha256: string;
  path: string;
  extension: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ProductProjection {
  productId: string;
  batchId: string;
  state: string;
  slots: Array<{
    slotId: string;
    slotNumber: number;
    role: string;
    state: string;
    attempt: number;
    remoteOutputUrl: string | null;
    archivedAssetId: string | null;
    error: unknown;
  }>;
}

export class ImageGenerationRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async loadStartContext(input: LoadGenerationStartContextInput): Promise<LoadGenerationStartContextResult> {
    const product = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${schema.products} WHERE id = $1`,
      [input.productId]
    );
    if (!product.rows[0]) throw commandError("product_not_found");

    const revision = await this.pool.query<{
      source_title: string | null;
      source_payload: Record<string, unknown>;
    }>(
      `SELECT source_title, source_payload
       FROM ${schema.productRevisions}
       WHERE id = $1 AND product_id = $2`,
      [input.revisionId, input.productId]
    );
    const revisionRow = revision.rows[0];
    if (!revisionRow) throw commandError("revision_not_found");

    const assets = await this.pool.query<{
      id: string;
      product_id: string;
      revision_id: string | null;
      state: string;
    }>(
      `SELECT id, product_id, revision_id, state
       FROM ${schema.assets}
       WHERE id = ANY($1::text[])`,
      [input.selectedAssetIds]
    );
    const byId = new Map(assets.rows.map((row) => [row.id, row]));
    for (const assetId of input.selectedAssetIds) {
      const asset = byId.get(assetId);
      if (!asset || asset.product_id !== input.productId || asset.revision_id !== input.revisionId) {
        throw commandError("asset_not_in_revision");
      }
      if (asset.state !== "ready") throw commandError("asset_not_ready");
    }

    const source = revisionRow.source_payload ?? {};
    const title = revisionRow.source_title ?? (typeof source.title === "string" ? source.title : "");
    const category = typeof source.category === "string" ? source.category : null;
    const attributes = Array.isArray(source.attributes)
      ? source.attributes
      : Array.isArray(source.sourceAttributes)
        ? source.sourceAttributes
        : [];

    return {
      productFacts: Object.freeze({ title, category, attributes })
    };
  }

  /**
   * Create a batch atomically with one image_prompt_plan job and requested slots.
   * Idempotent via unique idempotency_key on image_generation_batches.
   */
  async createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Check if batch already exists (idempotent re-entry)
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.imageGenerationBatches} WHERE idempotency_key = $1`,
        [input.idempotencyKey]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        assert(existing.rows[0], "existing batch must be returned");
        // Still need to return a planner job id — look it up by batch_id
        const plannerJob = await client.query<{ id: string }>(
          `SELECT id FROM ${schema.jobs}
           WHERE batch_key = $1 AND kind = 'image_prompt_plan'
           ORDER BY created_at ASC LIMIT 1`,
          [existing.rows[0].id]
        );
        await client.query("COMMIT");
        return { batchId: existing.rows[0].id, plannerJobId: plannerJob.rows[0]?.id ?? "" };
      }

      // Lock template version for read
      const templateVersion = await client.query(
        `SELECT id, recipe FROM ${schema.imageGenerationTemplateVersions}
         WHERE id = $1 FOR UPDATE`,
        [input.templateVersionId]
      );
      assert(templateVersion.rowCount && templateVersion.rowCount > 0, "template version must exist");
      const recipe = templateVersion.rows[0].recipe as ImageGenerationRecipeV1;

      const revisionCheck = await client.query(
        `SELECT id FROM ${schema.productRevisions}
         WHERE id = $1 AND product_id = $2`,
        [input.revisionId, input.productId]
      );
      if (!revisionCheck.rows[0]) throw commandError("revision_not_found");

      // Re-check source ownership inside the batch transaction so a Web preflight
      // cannot be invalidated between validation and persistence.
      const assetCheck = await client.query<{
        id: string;
        product_id: string;
        revision_id: string | null;
        state: string;
      }>(
        `SELECT id, product_id, revision_id, state FROM ${schema.assets}
         WHERE id = ANY($1::text[])`,
        [input.selectedAssetIds]
      );
      const selectedById = new Map(assetCheck.rows.map((row) => [row.id, row]));
      for (const assetId of input.selectedAssetIds) {
        const asset = selectedById.get(assetId);
        if (!asset || asset.product_id !== input.productId || asset.revision_id !== input.revisionId) {
          throw commandError("asset_not_in_revision");
        }
        if (asset.state !== "ready") throw commandError("asset_not_ready");
      }

      // Insert batch
      const batchId = newId("batch");
      const now = new Date();
      await client.query(
        `INSERT INTO ${schema.imageGenerationBatches}
         (id, product_id, revision_id, idempotency_key, selected_asset_ids,
          requested_output_count, category_key, template_id, template_version_id,
          template_version, recipe_snapshot, product_facts_snapshot, product_facts_digest, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'planning', $14, $14)`,
        [
          batchId,
          input.productId,
          input.revisionId,
          input.idempotencyKey,
          JSON.stringify(input.selectedAssetIds),
          input.requestedOutputCount,
          input.categoryKey,
          input.templateId,
          input.templateVersionId,
          input.templateVersion,
          JSON.stringify(input.recipe),
          JSON.stringify(input.productFacts),
          input.productFactsDigest,
          now
        ]
      );

      // Insert slots
      for (let i = 0; i < input.requestedOutputCount; i++) {
        const slotId = newId("slot");
        await client.query(
          `INSERT INTO ${schema.imageGenerationSlots}
           (id, batch_id, slot_number, role, state, attempt, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'waiting_for_plan', 0, $5, $5)`,
          [slotId, batchId, i + 1, recipe.roles[i]?.key ?? "default", now]
        );
      }

      // Insert planner job
      const plannerJobId = newId("job");
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key, created_at, updated_at)
         VALUES ($1, 'image_prompt_plan', $2, $2, $3::jsonb, 'queued', 3, $4, $5, $5)`,
        [
          plannerJobId,
          `plan:${input.idempotencyKey}`,
          JSON.stringify({ batchId, version: 1 }),
          batchId,
          now
        ]
      );

      await client.query("COMMIT");
      return { batchId, plannerJobId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load the context needed by the planner worker.
   */
  async loadPlanningContext(batchId: string): Promise<LoadPlanningContextResult | null> {
    const batch = await this.pool.query(
      `SELECT b.id, b.product_id, b.revision_id, b.template_id, b.template_version_id,
              b.recipe_snapshot, b.selected_asset_ids, b.product_facts_snapshot,
              tv.recipe
       FROM ${schema.imageGenerationBatches} b
       JOIN ${schema.imageGenerationTemplateVersions} tv ON tv.id = b.template_version_id
       WHERE b.id = $1`,
      [batchId]
    );
    if (!batch.rowCount || batch.rowCount === 0) return null;
    const row = batch.rows[0];
    const selectedAssetIds: string[] = Array.isArray(row.selected_asset_ids)
      ? row.selected_asset_ids.map(String)
      : [];
    const assets = await this.pool.query<{
      id: string;
      local_path: string | null;
      extension: string | null;
      state: string;
    }>(
      `SELECT id, local_path, extension, state
       FROM ${schema.assets}
       WHERE id = ANY($1::text[])
         AND product_id = $2
         AND revision_id = $3`,
      [selectedAssetIds, row.product_id, row.revision_id]
    );
    const byId = new Map(assets.rows.map((asset) => [asset.id, asset]));
    const references = selectedAssetIds.map((assetId): ResolvedImageReferenceV1 => {
      const asset = byId.get(assetId);
      const extension = asset?.extension?.toLowerCase();
      if (!asset || asset.state !== "ready" || !asset.local_path ||
          (extension !== "png" && extension !== "jpg" && extension !== "jpeg")) {
        throw commandError("asset_not_ready");
      }
      return Object.freeze({ assetId, localPath: asset.local_path, extension });
    });
    return {
      batchId: row.id,
      productId: row.product_id,
      revisionId: row.revision_id,
      templateId: row.template_id,
      templateVersionId: row.template_version_id,
      recipe: row.recipe_snapshot as ImageGenerationRecipeV1,
      references,
      productFacts: row.product_facts_snapshot as Record<string, unknown>
    };
  }

  /**
   * Save planned prompts and enqueue one image_generate_slot job per slot.
   * Updates only slots in 'waiting_for_plan' state.
   */
  async savePlanAndQueueSlots(input: SavePlanAndQueueSlotsInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const prompt of input.prompts) {
        const promptHash = createHash("sha256").update(JSON.stringify(prompt)).digest("hex");
        const slotResult = await client.query<{ id: string }>(
          `UPDATE ${schema.imageGenerationSlots}
           SET prompt = $1::jsonb,
               prompt_hash = $2,
               state = 'queued',
               updated_at = now()
           WHERE batch_id = $3 AND slot_number = $4 AND state = 'waiting_for_plan'
           RETURNING id`,
          [
            JSON.stringify(prompt),
            promptHash,
            input.batchId,
            prompt.slot
          ]
        );
        if (slotResult.rowCount && slotResult.rowCount > 0) {
          assert(slotResult.rows[0], "updated slot must be returned");
          const slotId = slotResult.rows[0].id;
          const jobId = newId("job");
          await client.query(
            `INSERT INTO ${schema.jobs}
             (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key, created_at, updated_at)
             VALUES ($1, 'image_generate_slot', $2, $2, $3::jsonb, 'queued', 3, $4, now(), now())
             ON CONFLICT (kind, business_key) DO NOTHING`,
            [
              jobId,
              `slot:${input.batchId}:${prompt.slot}:${promptHash}`,
              JSON.stringify({ version: 1, batchId: input.batchId, slotId, slotNumber: prompt.slot, attempt: 0 }),
              input.batchId
            ]
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load slot execution data for the slot worker.
   */
  async loadSlotExecution(slotId: string, fence: SlotFence): Promise<LoadSlotExecutionResult | null> {
    const slot = await this.pool.query(
      `SELECT s.id, s.batch_id, s.slot_number, s.role, s.prompt, s.state,
              s.attempt, s.remote_task_id, s.remote_output_url, s.error,
              b.selected_asset_ids, b.recipe_snapshot
       FROM ${schema.imageGenerationSlots} s
       JOIN ${schema.imageGenerationBatches} b ON b.id = s.batch_id
       JOIN ${schema.jobs} j ON j.batch_key = s.batch_id AND j.kind = 'image_generate_slot'
       WHERE s.id = $1 AND j.id = $2 AND j.status = 'running'
         AND j.owner = $3 AND j.lease_token = $4 AND j.lease_expires_at > now()
       FOR UPDATE OF s`,
      [slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    if (!slot.rowCount || slot.rowCount === 0) return null;
    const row = slot.rows[0];
    const selectedAssetIds: string[] = Array.isArray(row.selected_asset_ids)
      ? row.selected_asset_ids.map(String)
      : [];
    const referenceRows = selectedAssetIds.length === 0
      ? { rows: [] as Array<{ id: string; local_path: string; extension: "png" | "jpg" | "jpeg" }> }
      : await this.pool.query<{
        id: string;
        local_path: string;
        extension: "png" | "jpg" | "jpeg";
      }>(
        `SELECT id, local_path, lower(extension) AS extension
         FROM ${schema.assets}
         WHERE id = ANY($1::text[]) AND state = 'ready'
           AND local_path IS NOT NULL AND local_path <> ''
           AND lower(extension) IN ('png', 'jpg', 'jpeg')`,
        [selectedAssetIds]
      );
    const referenceById = new Map(referenceRows.rows.map((asset) => [asset.id, asset]));
    const references = selectedAssetIds.map((assetId): ResolvedImageReferenceV1 => {
      const asset = referenceById.get(assetId);
      if (!asset) throw commandError("image_reference_unavailable");
      return { assetId: asset.id, localPath: asset.local_path, extension: asset.extension };
    });
    const recipe = row.recipe_snapshot as ImageGenerationRecipeV1;
    return {
      slotId: row.id,
      batchId: row.batch_id,
      slotNumber: row.slot_number,
      role: row.role,
      prompt: row.prompt as PlannedImagePromptV1 | null,
      state: row.state,
      attempt: Number(row.attempt),
      remoteTaskId: row.remote_task_id,
      remoteOutputUrl: row.remote_output_url,
      error: row.error,
      references,
      parameters: recipe.providerParameters
    };
  }

  /**
   * Persist the remote task ID for a slot.
   */
  async saveRemoteTask(slotId: string, fence: SlotFence, remoteTaskId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots} s
       SET remote_task_id = $1, updated_at = now()
       FROM ${schema.jobs} j
       WHERE s.id = $2 AND j.batch_key = s.batch_id
         AND j.id = $3 AND j.owner = $4 AND j.lease_token = $5
         AND j.status = 'running' AND j.lease_expires_at > now()
         AND s.state = 'queued'`,
      [remoteTaskId, slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async saveRemoteOutput(slotId: string, fence: SlotFence, remoteOutputUrl: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots} s
       SET remote_output_url = $1, state = 'archiving', updated_at = now()
       FROM ${schema.jobs} j
       WHERE s.id = $2 AND j.id = $3 AND j.batch_key = s.batch_id
         AND j.owner = $4 AND j.lease_token = $5
         AND j.status = 'running' AND j.lease_expires_at > now()
         AND s.state IN ('queued', 'polling', 'archiving')`,
      [remoteOutputUrl, slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async archiveSlotOutput(
    slotId: string,
    archived: ArchivedImageOutput,
    fence: SlotFence
  ): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const context = await client.query<{
        state: string;
        archived_asset_id: string | null;
        product_id: string;
        revision_id: string;
      }>(
        `SELECT s.state, s.archived_asset_id, b.product_id, b.revision_id
         FROM ${schema.imageGenerationSlots} s
         JOIN ${schema.imageGenerationBatches} b ON b.id = s.batch_id
         JOIN ${schema.productRevisions} r ON r.id = b.revision_id
         JOIN ${schema.jobs} j ON j.id = $2 AND j.batch_key = s.batch_id
           AND j.kind = 'image_generate_slot'
         WHERE s.id = $1 AND j.status = 'running'
           AND j.owner = $3 AND j.lease_token = $4
           AND j.lease_expires_at > now()
         FOR UPDATE OF s, b, r`,
        [slotId, fence.jobId, fence.owner, fence.leaseToken]
      );
      const row = context.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.archived_asset_id && row.state === "succeeded") {
        await client.query("COMMIT");
        return row.archived_asset_id;
      }
      if (!["queued", "polling", "archiving"].includes(row.state)) {
        await client.query("ROLLBACK");
        return null;
      }

      const matching = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.assets}
         WHERE revision_id = $1 AND kind = 'generated'
           AND (remote_url = $2 OR sha256 = $3)
         ORDER BY CASE WHEN remote_url = $2 THEN 0 ELSE 1 END, created_at, id
         LIMIT 1
         FOR UPDATE`,
        [row.revision_id, archived.remoteUrl, archived.sha256]
      );
      let assetId = matching.rows[0]?.id;
      if (assetId) {
        await client.query(
          `UPDATE ${schema.assets}
           SET state = 'ready', sha256 = $2, local_path = $3, extension = $4,
               width = $5, height = $6
           WHERE id = $1`,
          [assetId, archived.sha256, archived.path, archived.extension, archived.width, archived.height]
        );
      } else {
        assetId = newId("asset");
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ${schema.assets}
           (id, product_id, revision_id, remote_url, kind, state, width, height,
            sha256, local_path, extension)
           VALUES ($1, $2, $3, $4, 'generated', 'ready', $5, $6, $7, $8, $9)
           ON CONFLICT (revision_id, remote_url) WHERE revision_id IS NOT NULL
           DO UPDATE SET kind = 'generated', state = 'ready', width = EXCLUDED.width,
             height = EXCLUDED.height, sha256 = EXCLUDED.sha256,
             local_path = EXCLUDED.local_path, extension = EXCLUDED.extension
           RETURNING id`,
          [
            assetId,
            row.product_id,
            row.revision_id,
            archived.remoteUrl,
            archived.width,
            archived.height,
            archived.sha256,
            archived.path,
            archived.extension
          ]
        );
        assetId = inserted.rows[0]!.id;
      }

      const updated = await client.query(
        `UPDATE ${schema.imageGenerationSlots}
         SET state = 'succeeded', archived_asset_id = $2, remote_output_url = $3,
             error = NULL, updated_at = now()
         WHERE id = $1 AND state IN ('queued', 'polling', 'archiving')`,
        [slotId, assetId, archived.remoteUrl]
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return assetId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Mark a slot as failed with an error.
   */
  async markSlotFailed(slotId: string, error: unknown, fence: SlotFence): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots} s
       SET state = 'failed', error = $1, updated_at = now()
       FROM ${schema.jobs} j
       WHERE s.id = $2 AND j.batch_key = s.batch_id
         AND j.id = $3 AND j.owner = $4 AND j.lease_token = $5
         AND s.state IN ('queued', 'submitting', 'polling', 'archiving')`,
      [JSON.stringify(error), slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Exclude a slot from the batch (user-initiated exclusion, worker version with fence).
   */
  async excludeSlot(slotId: string, fence: SlotFence): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots} s
       SET state = 'excluded', excluded_at = now(), updated_at = now()
       FROM ${schema.jobs} j
       WHERE s.id = $1 AND j.batch_key = s.batch_id
         AND j.id = $2 AND j.owner = $3 AND j.lease_token = $4
         AND s.state IN ('waiting_for_plan', 'queued')`,
      [slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Exclude a slot from the batch (web-initiated, no fence required).
   */
  async excludeSlotWeb(slotId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots}
       SET state = 'excluded', excluded_at = now(), updated_at = now()
       WHERE id = $1 AND state IN ('waiting_for_plan', 'queued')`,
      [slotId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Retry a failed slot (web-initiated, no fence required).
   * Requeues the slot by inserting a new image_generate_slot job.
   */
  async retrySlot(slotId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Load the slot and its batch to get the prompt hash for idempotency
      const slot = await client.query(
        `SELECT s.id, s.batch_id, s.slot_number, s.prompt, s.attempt, s.state
         FROM ${schema.imageGenerationSlots} s
         WHERE s.id = $1 AND s.state = 'failed'`,
        [slotId]
      );
      if (!slot.rowCount || slot.rowCount === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const row = slot.rows[0] as { id: string; batch_id: string; slot_number: number; prompt: PlannedImagePromptV1 | null; attempt: number; state: string };

      // Reset slot state to queued and increment attempt
      await client.query(
        `UPDATE ${schema.imageGenerationSlots}
         SET state = 'queued', error = NULL, attempt = attempt + 1,
             remote_task_id = NULL, remote_output_url = NULL, archived_asset_id = NULL,
             updated_at = now()
         WHERE id = $1`,
        [slotId]
      );

      // Insert a new job for this retry (idempotent via business_key conflict)
      const newAttempt = row.attempt + 1;
      const jobId = newId("job");
      const promptAttemptHash = createHash("sha256")
        .update(JSON.stringify(row.prompt ?? {}))
        .update(":")
        .update(String(newAttempt))
        .digest("hex");
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key, created_at, updated_at)
         VALUES ($1, 'image_generate_slot', $2, $2, $3::jsonb, 'queued', 3, $4, now(), now())
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [
          jobId,
          `slot:${row.batch_id}:${row.slot_number}:${promptAttemptHash}`,
          JSON.stringify({ version: 1, batchId: row.batch_id, slotId, slotNumber: row.slot_number, attempt: newAttempt }),
          row.batch_id
        ]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Accept a partial successful batch.
   */
  async acceptPartial(batchId: string, acceptedAssetIds: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.imageGenerationBatches}
       SET accepted_asset_ids = $1, state = 'partial_success', updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(acceptedAssetIds), batchId]
    );
  }

  /**
   * Get the full product projection across all slots for a product.
   */
  async getProductProjection(productId: string): Promise<ProductProjection | null> {
    const batch = await this.pool.query(
      `SELECT id, state FROM ${schema.imageGenerationBatches}
       WHERE product_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [productId]
    );
    if (!batch.rowCount || batch.rowCount === 0) return null;
    const row = batch.rows[0];
    const slots = await this.pool.query(
      `SELECT id, slot_number, role, state, attempt, remote_output_url, archived_asset_id, error
       FROM ${schema.imageGenerationSlots}
       WHERE batch_id = $1
       ORDER BY slot_number ASC`,
      [row.id]
    );
    return {
      productId,
      batchId: row.id,
      state: row.state,
      slots: slots.rows.map((s) => ({
        slotId: s.id,
        slotNumber: Number(s.slot_number),
        role: s.role,
        state: s.state,
        attempt: Number(s.attempt),
        remoteOutputUrl: s.remote_output_url,
        archivedAssetId: s.archived_asset_id,
        error: s.error
      }))
    };
  }
}
