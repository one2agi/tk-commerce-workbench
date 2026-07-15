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

      // Reuse path: same (revision_id, processing_version) already exists.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.automationRuns}
         WHERE revision_id = $1 AND processing_version = $2
         FOR UPDATE`,
        [input.revisionId, input.processingVersion]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        await client.query("COMMIT");
        return { runId: existing.rows[0].id, created: false };
      }

      // First-touch path: create the run, then enqueue the first free job.
      const runId = newId("ar");
      await client.query(
        `INSERT INTO ${schema.automationRuns}
         (id, revision_id, processing_version, state)
         VALUES ($1, $2, $3, 'queued')`,
        [runId, input.revisionId, input.processingVersion]
      );

      // Enqueue the bootstrapping job (miaoshou_collect) keyed by run id so it is also
      // idempotent across replays. The Worker (Wave 2) picks it up via claim().
      const jobId = newId("job");
      const businessKey = `automation:${runId}:boot`;
      await client.query(
        `INSERT INTO ${schema.jobs}
          (id, kind, business_key, idempotency_key, payload, status, max_attempts)
         VALUES ($1, 'miaoshou_collect', $2, $3, $4::jsonb, 'queued', $5)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [
          jobId,
          businessKey,
          `automation-${runId}`,
          JSON.stringify({
            version: 1,
            revisionId: input.revisionId
          }),
          3
        ]
      );

      await client.query("COMMIT");
      return { runId, created: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
