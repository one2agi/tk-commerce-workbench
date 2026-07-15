// Automation run repository.
//
// Contract surface freeze (Plan Task 4): the Web agent compiles against this signature.
// `createOrReuseAndEnqueue({ revisionId, processingVersion })` is a SINGLE transaction
// that:
//   1. Inserts an automation_runs row keyed by (revision_id, processing_version).
//   2. If `created`, enqueues the single free "first" job for this round by writing to
//      the jobs table with a deterministic business_key (`automation:${runId}:boot`).
//   3. Returns `{ runId, created }` so callers can distinguish first-touch from reuse.

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export interface CreateOrReuseInput {
  revisionId: string;
  processingVersion: number;
}

export interface CreateOrReuseResult {
  runId: string;
  created: boolean;
}

export class AutomationRunRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async createOrReuseAndEnqueue(input: CreateOrReuseInput): Promise<CreateOrReuseResult> {
    assert(input.revisionId.length > 0, "revisionId required");
    assert(input.processingVersion > 0, "processingVersion must be positive");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // INSERT ... ON CONFLICT is the concurrency boundary. A prior SELECT cannot
      // protect a missing row: two transactions could both observe absence.
      const candidateRunId = newId("ar");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ${schema.automationRuns}
         (id, revision_id, processing_version, state)
         VALUES ($1, $2, $3, 'queued')
         ON CONFLICT (revision_id, processing_version) DO NOTHING
         RETURNING id`,
        [candidateRunId, input.revisionId, input.processingVersion]
      );
      const created = (inserted.rowCount ?? 0) > 0;
      let runId = inserted.rows[0]?.id;
      if (!runId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM ${schema.automationRuns}
           WHERE revision_id = $1 AND processing_version = $2`,
          [input.revisionId, input.processingVersion]
        );
        assert(existing.rows[0], "conflicting automation run must exist");
        runId = existing.rows[0].id;
      }

      if (created) {
        const revision = await client.query<{ source_payload: Record<string, unknown> }>(
          `SELECT source_payload FROM ${schema.productRevisions} WHERE id = $1`,
          [input.revisionId]
        );
        assert(revision.rows[0], "revision must exist");
        const remoteUrls = extractRemoteUrls(revision.rows[0].source_payload ?? {});
        const jobId = newId("job");
        const businessKey = `automation:${runId}:boot`;
        await client.query(
          `INSERT INTO ${schema.jobs}
            (id, kind, business_key, idempotency_key, payload, status, max_attempts)
           VALUES ($1, 'asset_archive', $2, $3, $4::jsonb, 'queued', $5)
           ON CONFLICT (kind, business_key) DO NOTHING`,
          [
            jobId,
            businessKey,
            `automation-${runId}`,
            JSON.stringify({ version: 1, revisionId: input.revisionId, remoteUrls }),
            3
          ]
        );
      }

      await client.query("COMMIT");
      return { runId, created };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function extractRemoteUrls(payload: Record<string, unknown>): string[] {
  const candidates = [payload.remoteUrls, payload.imageUrls, payload.images];
  const urls = candidates.flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && "url" in item) {
        const url = (item as { url?: unknown }).url;
        return typeof url === "string" ? [url] : [];
      }
      return [];
    });
  });
  return [...new Set(urls.filter((url) => /^https?:\/\//.test(url)))];
}
