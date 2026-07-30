import { miaoshouDetailId } from "@tk/contracts/ids";
import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";

import type { QueryPort } from "./product-service";

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export class MiaoshouSyncService {
  constructor(private readonly database: QueryPort) {}

  async list(): Promise<{ items: MiaoshouSyncStatusV1[] }> {
    const result = await this.database.query(
      `SELECT id, approval_snapshot_id, state, remote_detail_id, last_reconciled_at, error
       FROM miaoshou_syncs ORDER BY updated_at DESC, created_at DESC`
    );
    return {
      items: result.rows.map((row) => ({
        syncId: String(row.id),
        approvalSnapshotId: String(row.approval_snapshot_id),
        state: String(row.state) as MiaoshouSyncStatusV1["state"],
        remoteDetailId: typeof row.remote_detail_id === "string" ? miaoshouDetailId(row.remote_detail_id) : null,
        lastReconciledAt: toIsoTimestamp(row.last_reconciled_at),
        error: (row.error ?? null) as MiaoshouSyncStatusV1["error"]
      }))
    };
  }
}
