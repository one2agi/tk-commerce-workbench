// Asset repository. Stores product images keyed by (product_id, remote_url). State
// tracks archive progress. Ordering of final assets is captured on approval_snapshots
// rather than on this table (so we can re-order without bumping asset rows).

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export class AssetRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async upsert(input: {
    productId: string;
    revisionId: string | null;
    remoteUrl: string;
    kind: "main" | "detail" | "sku";
    width?: number;
    height?: number;
    sha256?: string;
  }): Promise<string> {
    assert(input.productId.length > 0, "productId required");
    assert(input.remoteUrl.length > 0, "remoteUrl required");
    const id = newId("asset");
    // Use ON CONFLICT on product_id+remote_url to keep lookups stable.
    await this.pool.query(
      `INSERT INTO ${schema.assets}
       (id, product_id, revision_id, remote_url, kind, width, height, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.productId,
        input.revisionId,
        input.remoteUrl,
        input.kind,
        input.width ?? null,
        input.height ?? null,
        input.sha256 ?? null
      ]
    );
    // Return existing id when conflict happened.
    const row = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${schema.assets}
       WHERE product_id = $1 AND remote_url = $2`,
      [input.productId, input.remoteUrl]
    );
    return row.rows[0].id;
  }

  async recordProcessed(input: {
    assetId: string;
    sha256: string;
    localPath: string;
    extension: string;
    perceptualHash: string;
    clarity: number;
    duplicateDistance: number;
    watermarkProbability: number;
    collageProbability: number;
    nonProductProbability: number;
    visualScore: number;
    chosenRole: string | null;
    rejectionReason: string | null;
  }): Promise<void> {
    assert(input.assetId.length > 0, "assetId required");
    assert(input.sha256.length > 0, "sha256 required");
    assert(input.localPath.length > 0, "localPath required");
    const result = await this.pool.query(
      `UPDATE ${schema.assets}
       SET state = $2, sha256 = $3, local_path = $4, extension = $5,
           perceptual_hash = $6, clarity = $7, duplicate_distance = $8,
           watermark_probability = $9, collage_probability = $10,
           non_product_probability = $11, visual_score = $12,
           chosen_role = $13, rejection_reason = $14
       WHERE id = $1`,
      [
        input.assetId,
        input.rejectionReason ? "rejected" : "ready",
        input.sha256,
        input.localPath,
        input.extension,
        input.perceptualHash,
        input.clarity,
        input.duplicateDistance,
        input.watermarkProbability,
        input.collageProbability,
        input.nonProductProbability,
        input.visualScore,
        input.chosenRole,
        input.rejectionReason
      ]
    );
    assert(result.rowCount === 1, "asset not found");
  }
}
