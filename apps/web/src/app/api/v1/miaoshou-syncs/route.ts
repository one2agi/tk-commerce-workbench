import pg from "pg";
import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";
import { miaoshouDetailId } from "@tk/contracts/ids";
import { rejectNonLoopback } from "../../../../server/auth/loopback";
import { loadRuntimeConfig } from "../../../../server/composition";

export interface SyncStatusPort { list(): Promise<{ items: MiaoshouSyncStatusV1[] }> }

export function createGetHandler(dependencies: { syncs: SyncStatusPort }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.syncs.list());
  };
}

let pool: pg.Pool | undefined;
function database(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: loadRuntimeConfig().databaseUrl });
  return pool;
}

const pgSyncs: SyncStatusPort = {
  async list() {
    const result = await database().query<{
      id: string; approval_snapshot_id: string; state: MiaoshouSyncStatusV1["state"];
      remote_detail_id: string | null; last_reconciled_at: Date | null; error: MiaoshouSyncStatusV1["error"];
    }>(`SELECT id, approval_snapshot_id, state, remote_detail_id, last_reconciled_at, error
        FROM miaoshou_syncs ORDER BY updated_at DESC, created_at DESC`);
    return { items: result.rows.map((row) => ({
      syncId: row.id,
      approvalSnapshotId: row.approval_snapshot_id,
      state: row.state,
      remoteDetailId: row.remote_detail_id ? miaoshouDetailId(row.remote_detail_id) : null,
      lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null,
      error: row.error
    })) };
  }
};

export async function GET(request: Request): Promise<Response> {
  return createGetHandler({ syncs: pgSyncs })(request);
}
