// Image generation repository: template versions, batches, and independent slots.
//
// Provides transactional creation of batches with planner jobs, atomic slot state
// transitions, and idempotent re-entry via unique constraints.

import { strict as assert } from "node:assert";
import type { ImageGenerationRecipeV1, PlannedImagePromptV1 } from "@tk/contracts";
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
  selectedAssetIds: string[];
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

      // Verify all selected assets are ready
      const assetCheck = await client.query(
        `SELECT id FROM ${schema.assets}
         WHERE id = ANY($1) AND state = 'ready'`,
        [input.selectedAssetIds]
      );
      assert(
        assetCheck.rowCount === input.selectedAssetIds.length,
        "all selected assets must be ready"
      );

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
          [slotId, batchId, i + 1, recipe.roles[i] ?? "default", now]
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
    return {
      batchId: row.id,
      productId: row.product_id,
      revisionId: row.revision_id,
      templateId: row.template_id,
      templateVersionId: row.template_version_id,
      recipe: row.recipe_snapshot as ImageGenerationRecipeV1,
      selectedAssetIds: row.selected_asset_ids as string[],
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
            Buffer.from(JSON.stringify(prompt)).toString("base64"),
            input.batchId,
            prompt.slot
          ]
        );
        if (slotResult.rowCount && slotResult.rowCount > 0) {
          assert(slotResult.rows[0], "updated slot must be returned");
          const slotId = slotResult.rows[0].id;
          // Derive business_key from prompt hash for idempotency
          const promptHash = Buffer.from(JSON.stringify(prompt)).toString("base64");
          const jobId = newId("job");
          await client.query(
            `INSERT INTO ${schema.jobs}
             (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key, created_at, updated_at)
             VALUES ($1, 'image_generate_slot', $2, $2, $3::jsonb, 'queued', 3, $4, now(), now())
             ON CONFLICT (kind, business_key) DO NOTHING`,
            [
              jobId,
              `slot:${input.batchId}:${prompt.slot}:${promptHash.slice(0, 12)}`,
              JSON.stringify({ batchId: input.batchId, slotId, slotNumber: prompt.slot, version: 1 }),
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
              s.attempt, s.remote_task_id, s.remote_output_url, s.error
       FROM ${schema.imageGenerationSlots} s
       JOIN ${schema.jobs} j ON j.batch_key = s.batch_id AND j.kind = 'image_generate_slot'
       WHERE s.id = $1 AND j.id = $2 AND j.owner = $3 AND j.lease_token = $4
       FOR UPDATE OF s`,
      [slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    if (!slot.rowCount || slot.rowCount === 0) return null;
    const row = slot.rows[0];
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
      error: row.error
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
         AND s.state = 'queued'`,
      [remoteTaskId, slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Mark a slot as succeeded with the archived asset.
   */
  async markSlotSucceeded(slotId: string, archivedAssetId: string, fence: SlotFence): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.imageGenerationSlots} s
       SET state = 'succeeded', archived_asset_id = $1, updated_at = now()
       FROM ${schema.jobs} j
       WHERE s.id = $2 AND j.batch_key = s.batch_id
         AND j.id = $3 AND j.owner = $4 AND j.lease_token = $5
         AND s.state IN ('queued', 'polling', 'archiving')`,
      [archivedAssetId, slotId, fence.jobId, fence.owner, fence.leaseToken]
    );
    return (result.rowCount ?? 0) > 0;
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
   * Exclude a slot from the batch (user-initiated exclusion).
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
