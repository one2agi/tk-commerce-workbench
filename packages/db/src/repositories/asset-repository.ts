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
}
