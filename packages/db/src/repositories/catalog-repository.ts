// Catalog repository: local operator + product + revision CRUD.
//
// `upsertLocalOperator` is keyed by `handle` — same handle returns the same id.
// `insertRevision` enforces that the (product_id, draft_version) tuple is unique.
// If the same draft_version is inserted twice, we throw to preserve immutability.

import { strict as assert } from "node:assert";
import type { PoolClient } from "pg";

import { schema, type DbPool, type RevisionRow } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export class CatalogRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async upsertLocalOperator(input: {
    handle: string;
    displayName: string;
  }): Promise<string> {
    assert(input.handle.length > 0, "handle required");
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${schema.localOperators} WHERE handle = $1`,
      [input.handle]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0].id;
    }
    const id = newId("op");
    await this.pool.query(
      `INSERT INTO ${schema.localOperators} (id, handle, display_name)
       VALUES ($1, $2, $3)`,
      [id, input.handle, input.displayName]
    );
    return id;
  }

  async insertProduct(input: {
    operatorId: string;
    sourceUrl: string;
    locale: string;
    currency: string;
  }): Promise<string> {
    assert(input.operatorId.length > 0, "operatorId required");
    const id = newId("prod");
    await this.pool.query(
      `INSERT INTO ${schema.products} (id, operator_id, source_url, locale, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.operatorId, input.sourceUrl, input.locale, input.currency]
    );
    return id;
  }

  /**
   * Insert a revision row. Enforces unique (product_id, draft_version) and refuses to
   * overwrite an existing row by raising the database UNIQUE violation.
   */
  async insertRevision(input: {
    productId: string;
    draftVersion: number;
    sourceTitle: string;
    workingDraft: Record<string, unknown>;
  }): Promise<string> {
    const id = newId("rev");
    await this.pool.query(
      `INSERT INTO ${schema.productRevisions}
       (id, product_id, draft_version, source_title, working_draft, source_payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb)`,
      [
        id,
        input.productId,
        input.draftVersion,
        input.sourceTitle,
        JSON.stringify(input.workingDraft)
      ]
    );
    return id;
  }

  async listRevisions(productId: string): Promise<RevisionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, product_id, draft_version, source_title, source_payload, working_draft, version, created_at
       FROM ${schema.productRevisions}
       WHERE product_id = $1
       ORDER BY draft_version ASC`,
      [productId]
    );
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      draftVersion: Number(r.draft_version),
      sourceTitle: r.source_title,
      sourcePayload: r.source_payload ?? {},
      workingDraft: r.working_draft ?? {},
      version: String(r.version),
      createdAt: new Date(r.created_at)
    }));
  }

  /**
   * Run inside a caller-supplied transaction. Used by tests for atomic multi-step flows.
   */
  async withTransaction<T>(fn: (tx: CatalogRepository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txRepo = new TransactionCatalogRepository(client, this._schema);
      const out = await fn(txRepo);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

class TransactionCatalogRepository extends CatalogRepository {
  constructor(
    private readonly client: PoolClient,
    s: typeof schema
  ) {
    super(client as unknown as DbPool, s);
  }
  // The transaction variant delegates every query through the same client connection.
  // For Wave 1, repositories only need insertRevision inside transactions (ApprovalRepository
  // reuses this pattern); we keep the surface simple here.
}
