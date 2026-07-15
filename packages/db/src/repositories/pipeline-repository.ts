import { strict as assert } from "node:assert";
import type { MiaoshouSourceCollectResult } from "@tk/contracts";
import type { PoolClient } from "pg";
import { schema, type DbPool } from "../schema/index.js";

export interface PipelineFence {
  jobId: string;
  owner: string;
  leaseToken: string;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class PipelineRepository {
  constructor(private readonly pool: DbPool, private readonly operatorHandle = "local-operator") {}

  private async withFence<T>(fence: PipelineFence, operation: (client: PoolClient) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT id FROM ${schema.jobs}
         WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
           AND lease_expires_at > now()
         FOR UPDATE`,
        [fence.jobId, fence.owner, fence.leaseToken]
      );
      if ((owned.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveCollected(value: { batchId: string; sourceUrl: string; result: MiaoshouSourceCollectResult }, fence: PipelineFence): Promise<{ revisionId: string } | null> {
    return this.withFence(fence, async (client) => {
      const detail = value.result.detail;
      const operatorId = newId("op");
      await client.query(
        `INSERT INTO ${schema.localOperators} (id, handle, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (handle) DO NOTHING`,
        [operatorId, this.operatorHandle, "Local Operator"]
      );
      const operator = await client.query<{ id: string }>(`SELECT id FROM ${schema.localOperators} WHERE handle = $1`, [this.operatorHandle]);
      assert(operator.rows[0], "local operator must exist");
      const productId = newId("prod");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${schema.products}
         (id, operator_id, source_url, source_item_id, canonical_success_detail_id, locale, currency, state_source, state_automation)
         VALUES ($1, $2, $3, $4, $5, 'th-TH', 'THB', 'collected', 'not_started')
         ON CONFLICT (operator_id, source_item_id) WHERE source_item_id IS NOT NULL
         DO UPDATE SET source_url = EXCLUDED.source_url,
                       canonical_success_detail_id = EXCLUDED.canonical_success_detail_id,
                       state_source = 'collected', updated_at = now()
         RETURNING id`,
        [productId, operator.rows[0].id, value.sourceUrl, String(detail.sourceItemId), value.result.canonicalSuccessDetailId]
      );
      const canonicalProductId = inserted.rows[0]!.id;
      const existingRevision = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.productRevisions}
         WHERE product_id = $1 AND source_payload->>'detailId' = $2
         ORDER BY draft_version ASC LIMIT 1`,
        [canonicalProductId, detail.detailId]
      );
      const version = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(draft_version), 0) + 1 AS next_version FROM ${schema.productRevisions} WHERE product_id = $1`,
        [canonicalProductId]
      );
      const revisionId = existingRevision.rows[0]?.id ?? newId("rev");
      const sourcePayload = { ...detail, batchId: value.batchId };
      const workingDraft = {
        sourceLocale: "zh-CN",
        targetLocale: "th-TH",
        style: "neutral",
        pricingInputs: {
          domesticShippingCny: "0",
          crossBorderCostCny: "0",
          fixedTargetCostThb: "0",
          platformFeeRate: "0.05",
          paymentFeeRate: "0.03",
          targetProfitRate: "0.30",
          ending: "9"
        }
      };
      if (!existingRevision.rows[0]) {
        await client.query(
          `INSERT INTO ${schema.productRevisions}
           (id, product_id, draft_version, source_title, source_payload, working_draft)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [revisionId, canonicalProductId, Number(version.rows[0]?.next_version ?? 1), detail.title, JSON.stringify(sourcePayload), JSON.stringify(workingDraft)]
        );
      }
      await client.query(
        `INSERT INTO ${schema.miaoshouSourceRecords}
         (id, product_id, source_item_id, fetch_detail_id, skipped_detail_id, canonical_success_detail_id, fetched_payload, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'collected')`,
        [newId("source"), canonicalProductId, String(detail.sourceItemId), value.result.fetchDetailId, value.result.skippedDetailId,
          value.result.canonicalSuccessDetailId, JSON.stringify(value.result)]
      );
      return { revisionId };
    });
  }

  async saveArchive(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    const result = await this.withFence(fence, async (client) => {
      const revisionId = String(value.revisionId ?? "");
      const revision = await client.query<{ product_id: string }>(`SELECT product_id FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]);
      assert(revision.rows[0], "revision not found");
      for (const raw of Array.isArray(value.assets) ? value.assets : []) {
        const asset = object(raw);
        const remoteUrl = String(asset.remoteUrl ?? asset.finalUrl ?? "");
        if (!remoteUrl) continue;
        await client.query(
          `INSERT INTO ${schema.assets}
           (id, product_id, revision_id, remote_url, kind, state, sha256, local_path, extension)
           VALUES ($1, $2, $3, $4, 'main', 'ready', $5, $6, $7)
           ON CONFLICT (revision_id, remote_url) WHERE revision_id IS NOT NULL DO UPDATE
           SET state = 'ready', sha256 = EXCLUDED.sha256,
               local_path = EXCLUDED.local_path, extension = EXCLUDED.extension`,
          [newId("asset"), revision.rows[0].product_id, revisionId, remoteUrl, asset.sha256 ?? null, asset.path ?? null, asset.extension ?? null]
        );
      }
      await client.query(`UPDATE ${schema.products} SET state_asset_archive = $2, updated_at = now() WHERE id = $1`, [revision.rows[0].product_id, value.state]);
      return true;
    });
    return result === true;
  }

  async loadEvidence(revisionId: string) {
    const result = await this.pool.query<{ source_payload: Record<string, unknown>; working_draft: Record<string, unknown> }>(
      `SELECT source_payload, working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
    );
    const row = result.rows[0];
    assert(row, "revision not found");
    const source = object(row.source_payload);
    const draft = object(row.working_draft);
    return {
      sourceLocale: String(draft.sourceLocale ?? "zh-CN"),
      targetLocale: String(draft.targetLocale ?? "th-TH"),
      style: String(draft.style ?? "neutral"),
      sourceTitle: String(source.title ?? ""),
      sourceDescription: String(source.description ?? ""),
      sourceAttributes: Array.isArray(source.sourceAttributes) ? source.sourceAttributes as Array<{ name: string; value: string }> : []
    };
  }

  async saveResult(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    const result = await this.withFence(fence, async (client) => {
      const revisionId = String(value.revisionId ?? "");
      const revision = await client.query<{ product_id: string; draft_version: number; working_draft: Record<string, unknown> }>(
        `SELECT product_id, draft_version, working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
      );
      assert(revision.rows[0], "revision not found");
      const listingRunId = newId("listing");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${schema.listingDrafts}
         (id, product_id, revision_id, draft_version, target_locale, style, title, description, attributes, provider, model, fallback_used)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
         ON CONFLICT (revision_id, draft_version) DO UPDATE
         SET target_locale = EXCLUDED.target_locale, style = EXCLUDED.style, title = EXCLUDED.title,
             description = EXCLUDED.description, attributes = EXCLUDED.attributes, provider = EXCLUDED.provider,
             model = EXCLUDED.model, fallback_used = EXCLUDED.fallback_used
         RETURNING id`,
        [listingRunId, revision.rows[0].product_id, revisionId, revision.rows[0].draft_version,
          object(revision.rows[0].working_draft).targetLocale ?? "th-TH", value.styleApplied ?? "neutral", value.title ?? "", value.description ?? "",
          JSON.stringify(value.attributes ?? []), value.provider ?? "rules", value.model ?? null, Boolean(value.fallbackUsed)]
      );
      const stableListingRunId = inserted.rows[0]?.id ?? listingRunId;
      await client.query(
        `UPDATE ${schema.productRevisions}
         SET working_draft = working_draft || $2::jsonb, version = version + 1 WHERE id = $1`,
        [revisionId, JSON.stringify({ listingRunId: stableListingRunId, listing: value })]
      );
      await client.query(`UPDATE ${schema.products} SET state_listing = 'ready', updated_at = now() WHERE id = $1`, [revision.rows[0].product_id]);
      return true;
    });
    return result === true;
  }

  async loadInputs(revisionId: string) {
    const result = await this.pool.query<{ source_payload: Record<string, unknown>; working_draft: Record<string, unknown> }>(
      `SELECT source_payload, working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
    );
    const row = result.rows[0];
    assert(row, "revision not found");
    const source = object(row.source_payload);
    const draft = object(row.working_draft);
    const pricing = object(draft.pricingInputs);
    const sourcePrice = object(source.sourcePriceWire);
    const latestRate = await this.pool.query<{ id: string; rate: string }>(
      `SELECT id, rate FROM ${schema.exchangeRateSnapshots} WHERE base = 'CNY' AND target = 'THB' ORDER BY (source = 'manual') DESC, observed_at DESC LIMIT 1`
    );
    const amountMinor = String(sourcePrice.amountMinor ?? "");
    const sourceCostCny = amountMinor && /^\d+$/.test(amountMinor) ? (Number(amountMinor) / 100).toFixed(2) : null;
    return {
      weightKg: typeof source.weightKg === "string" ? source.weightKg : null,
      sourceCostCny,
      domesticShippingCny: typeof pricing.domesticShippingCny === "string" ? pricing.domesticShippingCny : null,
      crossBorderCostCny: typeof pricing.crossBorderCostCny === "string" ? pricing.crossBorderCostCny : null,
      exchangeRate: latestRate.rows[0]?.rate ?? null,
      exchangeRateSnapshotId: latestRate.rows[0]?.id ?? null,
      fixedTargetCostThb: String(pricing.fixedTargetCostThb ?? "0"),
      platformFeeRate: String(pricing.platformFeeRate ?? "0"),
      paymentFeeRate: String(pricing.paymentFeeRate ?? "0"),
      targetProfitRate: String(pricing.targetProfitRate ?? "0"),
      ending: String(pricing.ending ?? "9")
    };
  }

  async saveReady(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    const result = await this.withFence(fence, async (client) => {
      const revisionId = String(value.revisionId ?? "");
      const revision = await client.query<{ product_id: string; draft_version: number }>(
        `SELECT product_id, draft_version FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
      );
      assert(revision.rows[0], "revision not found");
      const price = object(value.finalPrice);
      const pricingRunId = newId("pricing");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${schema.pricingRuns}
         (id, product_id, revision_id, draft_version, state, breakdown, final_price_minor, final_currency, ending, exchange_rate_snapshot_id)
         VALUES ($1, $2, $3, $4, 'ready', $5::jsonb, $6, $7, $8, $9)
         ON CONFLICT (revision_id, draft_version) DO UPDATE
         SET state = 'ready', breakdown = EXCLUDED.breakdown, final_price_minor = EXCLUDED.final_price_minor,
             final_currency = EXCLUDED.final_currency, ending = EXCLUDED.ending,
             exchange_rate_snapshot_id = EXCLUDED.exchange_rate_snapshot_id, updated_at = now()
         RETURNING id`,
        [pricingRunId, revision.rows[0].product_id, revisionId, revision.rows[0].draft_version, JSON.stringify(value.breakdown ?? {}),
          price.amountMinor ?? null, price.currency ?? "THB", object(value.breakdown).ending ?? "9", value.exchangeRateSnapshotId ?? null]
      );
      const stablePricingRunId = inserted.rows[0]?.id ?? pricingRunId;
      await client.query(`UPDATE ${schema.productRevisions} SET working_draft = working_draft || $2::jsonb, version = version + 1 WHERE id = $1`,
        [revisionId, JSON.stringify({ pricingRunId: stablePricingRunId, pricing: value })]);
      return true;
    });
    return result === true;
  }

  async loadMatchInputs(revisionId: string) {
    const revision = await this.pool.query<{ source_payload: Record<string, unknown> }>(`SELECT source_payload FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]);
    assert(revision.rows[0], "revision not found");
    const templates = await this.pool.query<{ id: string; enabled: boolean; category_rules: Array<{ category: string; priority: number }> }>(
      `SELECT id, enabled, category_rules FROM ${schema.templates} WHERE enabled = true ORDER BY created_at ASC, id ASC`
    );
    assert(templates.rows[0], "workspace default template is unavailable");
    return {
      category: typeof revision.rows[0].source_payload.category === "string" ? revision.rows[0].source_payload.category : null,
      templates: templates.rows.map((row) => ({ id: row.id, enabled: row.enabled, rules: Array.isArray(row.category_rules) ? row.category_rules : [] })),
      defaultTemplateId: templates.rows[0].id
    };
  }

  async saveMatch(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      await client.query(`UPDATE ${schema.productRevisions} SET working_draft = working_draft || $2::jsonb, version = version + 1 WHERE id = $1`,
        [String(value.revisionId ?? ""), JSON.stringify({ templateMatch: value })]);
      return true;
    })) === true;
  }

  async loadSelectionInputs(revisionId: string) {
    const revision = await this.pool.query<{ product_id: string; working_draft: Record<string, unknown> }>(
      `SELECT product_id, working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
    );
    assert(revision.rows[0], "revision not found");
    const rows = await this.pool.query<{ id: string; local_path: string; chosen_role: string | null; visual_score: number | null; perceptual_hash: string | null }>(
      `SELECT id, local_path, chosen_role, visual_score, perceptual_hash FROM ${schema.assets}
       WHERE product_id = $1 AND revision_id = $2 AND state = 'ready' AND local_path IS NOT NULL`,
      [revision.rows[0].product_id, revisionId]
    );
    return {
      candidates: rows.rows.map((row) => ({ assetId: row.id, url: row.local_path, role: (row.chosen_role ?? "primary") as "primary", score: row.visual_score ?? 1, perceptualHash: row.perceptual_hash ?? row.id })),
      referenceUrls: [],
      capacity: Number(object(revision.rows[0].working_draft).canvasInputCapacity ?? 9)
    };
  }

  async saveSelection(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      await client.query(`UPDATE ${schema.productRevisions} SET working_draft = working_draft || $2::jsonb, version = version + 1 WHERE id = $1`,
        [String(value.revisionId ?? ""), JSON.stringify({ imageSelection: value })]);
      return true;
    })) === true;
  }

  async loadPlan(revisionId: string) {
    const revision = await this.pool.query<{ working_draft: Record<string, unknown> }>(`SELECT working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]);
    assert(revision.rows[0], "revision not found");
    const draft = object(revision.rows[0].working_draft);
    const selection = object(draft.imageSelection);
    const match = object(draft.templateMatch);
    const assetIds = Array.isArray(selection.assetIds) ? selection.assetIds.map(String) : [];
    const assets = assetIds.length === 0 ? { rows: [] } : await this.pool.query<{ id: string; local_path: string; chosen_role: string | null; visual_score: number | null; perceptual_hash: string | null }>(
      `SELECT id, local_path, chosen_role, visual_score, perceptual_hash FROM ${schema.assets} WHERE id = ANY($1::text[])`, [assetIds]
    );
    return {
      workflowId: String(draft.workflowId ?? "TK工作流"),
      templateVersion: Number(match.templateVersion ?? 1),
      productImages: assets.rows.map((row) => ({ assetId: row.id, url: row.local_path, role: (row.chosen_role ?? "primary") as "primary", score: row.visual_score ?? 1, perceptualHash: row.perceptual_hash ?? row.id })),
      referenceUrls: Array.isArray(selection.referenceUrls) ? selection.referenceUrls.map(String) : [],
      localAssetIds: assetIds,
      sourceLocale: String(draft.sourceLocale ?? "zh-CN"),
      targetLocale: String(draft.targetLocale ?? "th-TH"),
      style: String(draft.style ?? "neutral"),
      expectedOutputCount: Number(draft.expectedOutputCount ?? 5)
    };
  }

  async saveOutputs(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      const revisionId = String(value.revisionId ?? "");
      const revision = await client.query<{ product_id: string; working_draft: Record<string, unknown> }>(
        `SELECT product_id, working_draft FROM ${schema.productRevisions} WHERE id = $1`, [revisionId]
      );
      assert(revision.rows[0], "revision not found");
      const match = object(object(revision.rows[0].working_draft).templateMatch);
      await client.query(
        `INSERT INTO ${schema.canvasRuns}
         (id, product_id, revision_id, template_id, template_version, state, remote_task_id, outputs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (revision_id, template_version) DO UPDATE
         SET state = EXCLUDED.state, remote_task_id = EXCLUDED.remote_task_id,
             outputs = EXCLUDED.outputs, updated_at = now()`,
        [newId("canvas"), revision.rows[0].product_id, revisionId, String(match.templateId ?? "default"), Number(match.templateVersion ?? 1),
          value.state ?? "partial", value.remoteTaskId ?? null, JSON.stringify(value.outputs ?? [])]
      );
      await client.query(`UPDATE ${schema.products} SET state_canvas = $2, updated_at = now() WHERE id = $1`, [revision.rows[0].product_id, value.state]);
      return true;
    })) === true;
  }

  async markReady(value: { revisionId: string; state: "ready" }, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      const revision = await client.query<{ product_id: string }>(`SELECT product_id FROM ${schema.productRevisions} WHERE id = $1`, [value.revisionId]);
      assert(revision.rows[0], "revision not found");
      await client.query(`UPDATE ${schema.products} SET state_automation = 'ready', updated_at = now() WHERE id = $1`, [revision.rows[0].product_id]);
      return true;
    })) === true;
  }

  async recordProvider(value: Record<string, unknown>, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      await client.query(
        `INSERT INTO ${schema.exchangeRateSnapshots}
         (id, base, target, rate, source, observed_at, is_stale)
         VALUES ($1, $2, $3, $4, 'provider', $5::timestamptz, false)`,
        [newId("fx"), String(value.base ?? "CNY"), String(value.target ?? "THB"), String(value.rate ?? ""), String(value.observedAt ?? new Date().toISOString())]
      );
      return true;
    })) === true;
  }

  async latestSuccessful(base: string, target: string): Promise<{ id: string; rate: string; source: string; observedAt: string } | null> {
    const result = await this.pool.query<{ id: string; rate: string; source: string; observed_at: Date }>(
      `SELECT id, rate, source, observed_at FROM ${schema.exchangeRateSnapshots}
       WHERE base = $1 AND target = $2 ORDER BY (source = 'manual') DESC, observed_at DESC LIMIT 1`,
      [base, target]
    );
    const row = result.rows[0];
    return row ? { id: row.id, rate: row.rate, source: row.source, observedAt: new Date(row.observed_at).toISOString() } : null;
  }

  async markStale(snapshotId: string, fence: PipelineFence): Promise<boolean> {
    return (await this.withFence(fence, async (client) => {
      await client.query(`UPDATE ${schema.exchangeRateSnapshots} SET is_stale = true WHERE id = $1`, [snapshotId]);
      return true;
    })) === true;
  }
}

export function pipelineRepositories(repository: PipelineRepository) {
  return Object.freeze({
    collect: repository,
    archive: repository,
    listing: repository,
    pricing: repository,
    templates: repository,
    images: repository,
    canvas: repository,
    finalPreview: repository,
    exchangeRate: repository
  });
}
