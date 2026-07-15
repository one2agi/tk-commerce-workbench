// Approval repository.
//
// Contract surface freeze (Plan Task 4 / Wave 1 Core brief):
//   `confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<{ approvalSnapshotId; syncId }>`
//
// Frozen transaction boundary:
//   1. Insert an approval_snapshots row (state = 'approved') using the command's
//      expectedDraftVersion / expectedListingRunId / expectedPricingRunId /
//      expectedTemplateVersion. The DB UNIQUE constraint on
//      (product_id, revision_id, draft_version, listing_run_id, pricing_run_id)
//      makes this idempotent.
//   2. Insert/update the miaoshou_syncs row that references the snapshot (state =
//      'queued') so the Worker can claim a `miaoshou_edit` job against it.
//   3. Enqueue the `miaoshou_edit` job (idempotency by businessKey).
// All four writes happen in ONE transaction.
//
// Task 12 fills the mapping from ConfirmMiaoshouEditV1 to ApprovalSnapshotV1 — Web
// compiles against the frozen shape exposed here.

import { strict as assert } from "node:assert";

import type { ConfirmMiaoshouEditV1 } from "@tk/contracts";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export interface ConfirmResult {
  approvalSnapshotId: string;
  syncId: string;
}

export class ApprovalRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<ConfirmResult> {
    assert(command.version === 1, "ConfirmMiaoshouEditV1 version must be 1");
    assert(command.productId.length > 0, "productId required");
    assert(command.orderedFinalAssetIds.length > 0, "orderedFinalAssetIds required");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // We treat "draftVersion" as the row's draft_version integer and the listing/pricing
      // run ids as strings. The unique constraint makes the snapshot append-only per
      // (product_id, COALESCE(revision_id,''), draft_version, listing_run_id, pricing_run_id).
      // Note: revision_id is nullable in the schema (ConfirmMiaoshouEditV1 currently does not
      // carry a revisionId; Wave 2 will thread that mapping through).
      const snapshotId = newId("appr");
      const ins = await client.query<{ id: string }>(
        `INSERT INTO ${schema.approvalSnapshots}
          (id, product_id, revision_id, draft_version,
           listing_run_id, pricing_run_id, template_version,
           ordered_final_asset_ids, source_platform, source_canonical_url, source_item_id,
           canonical_success_detail_id, locale, currency,
           title, description, attributes, item_number, price_minor, price_currency, stock,
           weight_kg, dimensions, skus, state)
         VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7,
                 $8::jsonb, '1688', '', '', '', 'th-TH', 'THB',
                 '', '', '[]'::jsonb, NULL, '0', 'THB', 0,
                 '0', NULL, '[]'::jsonb, 'approved')
         ON CONFLICT ON CONSTRAINT approval_snapshots_unique_triplet
         DO UPDATE SET state = 'approved'
         RETURNING id`,
        [
          snapshotId,
          command.productId,
          "", // revision_id (web doesn't include it yet; Wave 2 will map here)
          command.expectedDraftVersion,
          command.expectedListingRunId,
          command.expectedPricingRunId,
          command.expectedTemplateVersion,
          JSON.stringify(command.orderedFinalAssetIds)
        ]
      );
      const approvalSnapshotId = ins.rows[0].id;

      // The sync row references the approval snapshot uniquely.
      const syncId = newId("sync");
      await client.query(
        `INSERT INTO ${schema.miaoshouSyncs}
         (id, approval_snapshot_id, state)
         VALUES ($1, $2, 'queued')
         ON CONFLICT (approval_snapshot_id)
         DO UPDATE SET state = 'queued', updated_at = now()`,
        [syncId, approvalSnapshotId]
      );

      // Enqueue the miaoshou_edit job. Idempotency via (kind, business_key).
      const jobId = newId("job");
      await client.query(
        `INSERT INTO ${schema.jobs}
          (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, 'miaoshou_edit', $2, $3, $4::jsonb, 'queued', $5)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [
          jobId,
          `miaoshou_edit:${approvalSnapshotId}`,
          `confirm-${approvalSnapshotId}`,
          JSON.stringify({
            version: 1,
            approvalSnapshotId,
            productId: command.productId,
            canonicalSuccessDetailId: ""
          }),
          3
        ]
      );

      await client.query("COMMIT");
      return { approvalSnapshotId, syncId };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
