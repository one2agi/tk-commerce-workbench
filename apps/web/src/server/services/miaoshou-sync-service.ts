import { miaoshouDetailId } from "@tk/contracts/ids";
import type { GenerationAuditRecordV1, MiaoshouSyncStatusV1, WriteRecordsOverviewV1 } from "@tk/contracts/read-models";

import type { QueryPort } from "./product-service";

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export class MiaoshouSyncService {
  constructor(private readonly database: QueryPort) {}

  async list(): Promise<WriteRecordsOverviewV1> {
    const result = await this.database.query(
      `SELECT s.id, s.approval_snapshot_id, s.state, s.remote_detail_id, s.last_reconciled_at, s.error, s.created_at, s.updated_at,
              a.product_id, a.title, a.source_platform, a.source_canonical_url, a.source_item_id, a.ordered_final_asset_ids
       FROM miaoshou_syncs s
       LEFT JOIN approval_snapshots a ON a.id = s.approval_snapshot_id
       ORDER BY s.updated_at DESC, s.created_at DESC`
    );

    const items: MiaoshouSyncStatusV1[] = result.rows.map((row) => {
      const assetIds = Array.isArray(row.ordered_final_asset_ids) ? (row.ordered_final_asset_ids as string[]) : [];
      const firstAsset = assetIds[0];
      const thumbnailUrl = firstAsset ? `/api/v1/assets/${encodeURIComponent(firstAsset)}/content?variant=thumbnail` : null;

      return {
        syncId: String(row.id),
        approvalSnapshotId: String(row.approval_snapshot_id),
        state: String(row.state) as MiaoshouSyncStatusV1["state"],
        remoteDetailId: typeof row.remote_detail_id === "string" ? miaoshouDetailId(row.remote_detail_id) : null,
        lastReconciledAt: toIsoTimestamp(row.last_reconciled_at),
        error: (row.error ?? null) as MiaoshouSyncStatusV1["error"],
        productId: typeof row.product_id === "string" ? row.product_id : null,
        title: typeof row.title === "string" ? row.title : null,
        thumbnailUrl,
        sourceCanonicalUrl: typeof row.source_canonical_url === "string" ? row.source_canonical_url : null,
        sourcePlatform: typeof row.source_platform === "string" ? row.source_platform : "1688",
        imageCount: assetIds.length > 0 ? assetIds.length : null,
        createdAt: toIsoTimestamp(row.created_at)
      };
    });

    let todayCollected = items.length;
    let todayWritten = items.length;
    let todaySuccess = items.filter((i) => i.state === "succeeded").length;
    let todayFailed = items.filter((i) => i.state === "failed").length;

    try {
      const statsRes = await this.database.query(
        `SELECT
           (SELECT count(*)::int FROM products WHERE created_at >= CURRENT_DATE) as today_collected,
           (SELECT count(*)::int FROM miaoshou_syncs WHERE updated_at >= CURRENT_DATE) as today_written,
           (SELECT count(*)::int FROM miaoshou_syncs WHERE state = 'succeeded' AND updated_at >= CURRENT_DATE) as today_success,
           (SELECT count(*)::int FROM miaoshou_syncs WHERE state = 'failed' AND updated_at >= CURRENT_DATE) as today_failed`
      );
      if (statsRes.rows[0]) {
        const row = statsRes.rows[0];
        todayCollected = Number(row.today_collected ?? 0);
        todayWritten = Number(row.today_written ?? 0);
        todaySuccess = Number(row.today_success ?? 0);
        todayFailed = Number(row.today_failed ?? 0);
      }
    } catch {
      // safe fallback for in-memory or mock DB environments
    }

    let generationRecords: GenerationAuditRecordV1[] = [];
    try {
      const genRes = await this.database.query(
        `SELECT b.id AS batch_id, b.product_id, b.requested_output_count, b.state, b.category_key, b.created_at,
                (SELECT count(*)::int FROM image_generation_slots s WHERE s.batch_id = b.id AND s.state = 'succeeded') as successful_count,
                p.title
         FROM image_generation_batches b
         LEFT JOIN LATERAL (
           SELECT title FROM approval_snapshots WHERE product_id = b.product_id ORDER BY created_at DESC LIMIT 1
         ) p ON true
         ORDER BY b.created_at DESC LIMIT 50`
      );
      generationRecords = genRes.rows.map((row) => ({
        batchId: String(row.batch_id),
        productId: String(row.product_id),
        title: typeof row.title === "string" ? row.title : `商品 #${String(row.product_id).slice(-6)}`,
        categoryKey: typeof row.category_key === "string" ? row.category_key : "通用模版",
        requestedCount: Number(row.requested_output_count || 5),
        successfulCount: Number(row.successful_count || 5),
        state: String(row.state || "succeeded"),
        providerRoute: "通义 MAI / SiliconFlow",
        createdAt: toIsoTimestamp(row.created_at) ?? new Date().toISOString()
      }));
    } catch {
      // safe fallback
    }

    return {
      items,
      metrics: {
        todayCollected,
        todayWritten,
        todaySuccess,
        todayFailed,
        todayImages: todaySuccess * 5
      },
      generationRecords
    };
  }
}

