import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export interface ApprovalInvalidationPort {
  invalidateInTransaction(client: PoolClient, productId: string, reason: string): Promise<boolean>;
}

class ApprovalSyncInProgressError extends Error {
  readonly code = "approval_sync_in_progress";

  constructor(readonly metadata: {
    approvalSnapshotId: string;
    syncState: string | null;
    jobStatus: string | null;
  }) {
    super("Approval cannot be invalidated while Miaoshou synchronization is in progress");
    this.name = "ApprovalSyncInProgressError";
  }
}

export function createApprovalInvalidationPort(): ApprovalInvalidationPort {
  return {
    async invalidateInTransaction(client, productId, reason) {
      // Shared approval mutation order: product -> approval -> sync -> job.
      const product = await client.query<{ id: string }>(
        `SELECT id FROM products WHERE id = $1 FOR UPDATE`, [productId]
      );
      if (!product.rows[0]) throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });

      const current = await client.query<{ id: string }>(
        `SELECT id FROM approval_snapshots
         WHERE product_id = $1 AND state = 'approved'
         ORDER BY created_at DESC, id DESC
         LIMIT 1 FOR UPDATE`, [productId]
      );
      const approvalSnapshotId = current.rows[0]?.id;
      if (!approvalSnapshotId) return false;

      const sync = await client.query<{ state: string }>(
        `SELECT state FROM miaoshou_syncs
         WHERE approval_snapshot_id = $1 FOR UPDATE`, [approvalSnapshotId]
      );
      const editJobs = await client.query<{ status: string }>(
        `SELECT status FROM jobs
         WHERE kind = 'miaoshou_edit' AND payload->>'approvalSnapshotId' = $1
         ORDER BY id FOR UPDATE`, [approvalSnapshotId]
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

      const failure = JSON.stringify({
        code: "approval_invalidated",
        safeMessage: "Approval changed before Miaoshou sync"
      });
      await client.query(
        `UPDATE approval_snapshots SET state = 'invalidated'
         WHERE id = $1 AND state = 'approved'`, [approvalSnapshotId]
      );
      await client.query(
        `UPDATE products SET state_approval = 'unapproved', updated_at = now()
         WHERE id = $1`, [productId]
      );
      await client.query(
        `UPDATE jobs
         SET status = 'failed', error = $2::jsonb,
             owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE kind = 'miaoshou_edit'
           AND payload->>'approvalSnapshotId' = $1
           AND status IN ('queued', 'paused')`, [approvalSnapshotId, failure]
      );
      await client.query(
        `UPDATE miaoshou_syncs SET state = 'failed', error = $2::jsonb, updated_at = now()
         WHERE approval_snapshot_id = $1 AND state = 'queued'`, [approvalSnapshotId, failure]
      );
      await client.query(
        `INSERT INTO audit_events (id, actor_type, action, target_kind, target_id, payload, redacted)
         VALUES ($1, 'operator', 'approval.invalidated', 'approval_snapshot', $2, $3::jsonb, true)`,
        [`audit_${randomUUID()}`, approvalSnapshotId, JSON.stringify({ productId, reason })]
      );
      return true;
    }
  };
}
