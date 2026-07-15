// Durable job repository. A random lease token fences each claim, so a worker whose
// lease expired cannot overwrite the result produced by a newer owner.

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export interface JobClaimInput {
  kind: string;
  businessKey: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface ClaimedJob {
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
  leaseToken: string;
}

export class JobRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async enqueue(input: JobClaimInput): Promise<string> {
    assert(input.kind.length > 0, "kind required");
    assert(input.businessKey.length > 0, "businessKey required");
    const max = input.maxAttempts ?? 3;
    const id = newId("job");
    const idemKey = input.idempotencyKey ?? input.businessKey;
    // ON CONFLICT (kind, business_key) DO NOTHING preserves idempotency — same key
    // re-enqueue returns the existing id below.
    const ins = await this.pool.query<{ id: string }>(
      `INSERT INTO ${schema.jobs}
        (id, kind, business_key, idempotency_key, payload, status, max_attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6)
       ON CONFLICT (kind, business_key) DO NOTHING
       RETURNING id`,
      [
        id,
        input.kind,
        input.businessKey,
        idemKey,
        JSON.stringify(input.payload),
        max
      ]
    );
    if (ins.rowCount && ins.rowCount > 0) return ins.rows[0].id;
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${schema.jobs} WHERE kind = $1 AND business_key = $2`,
      [input.kind, input.businessKey]
    );
    return existing.rows[0].id;
  }

  /**
   * Claim one eligible queued job under owner+lease. Expired running jobs must first
   * pass through releaseExpired(), which distinguishes safe retries from external
   * operations that require reconciliation.
   */
  async claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    assert(owner.length > 0, "owner required");
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const leaseToken = newId("lease");
    const client = await this.pool.connect();
    try {
      // Atomic claim via UPDATE ... RETURNING. The CTE makes this race-safe on real
      // Postgres and best-effort under PGlite.
      const updated = await client.query<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        lease_token: string;
      }>(
        `WITH candidate AS (
           SELECT id FROM ${schema.jobs}
           WHERE status = 'queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
             AND attempt < max_attempts
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ${schema.jobs} j
         SET status = 'running',
             owner = $1,
             lease_expires_at = $3::timestamptz,
             lease_token = $4,
             attempt = attempt + 1,
             last_heartbeat_at = $2::timestamptz,
             updated_at = now()
         FROM candidate
         WHERE j.id = candidate.id
         RETURNING j.id, j.kind, j.payload, j.lease_token`,
        [owner, now, leaseExpiresAt, leaseToken]
      );
      if (updated.rowCount === 0) return null;
      const row = updated.rows[0];
      return {
        jobId: row.id,
        kind: row.kind,
        payload: row.payload ?? {},
        leaseToken: row.lease_token
      };
    } finally {
      client.release();
    }
  }

  async heartbeat(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    leaseMs: number
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET last_heartbeat_at = $2::timestamptz, lease_expires_at = $3::timestamptz, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $4 AND lease_token = $5`,
      [jobId, now, new Date(now.getTime() + leaseMs), owner, leaseToken]
    );
    return result.rowCount === 1;
  }

  async complete(jobId: string, owner: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'succeeded', owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3`,
      [jobId, owner, leaseToken]
    );
    return result.rowCount === 1;
  }

  async fail(
    jobId: string,
    owner: string,
    leaseToken: string,
    error: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'failed', error = $4::jsonb, owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3`,
      [jobId, owner, leaseToken, JSON.stringify(error)]
    );
    return result.rowCount === 1;
  }

  async releaseExpired(now: Date): Promise<number> {
    const r = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = CASE
             WHEN remote_task_id IS NOT NULL
               OR kind IN ('miaoshou_collect', 'canvas_generate', 'miaoshou_edit')
               THEN 'needs_input'
             WHEN attempt >= max_attempts THEN 'failed'
             ELSE 'queued'
           END,
           error = CASE
             WHEN remote_task_id IS NOT NULL
               OR kind IN ('miaoshou_collect', 'canvas_generate', 'miaoshou_edit')
               THEN '{"code":"reconcile_required","message":"Lease expired after an external side effect; reconcile before retry"}'::jsonb
             WHEN attempt >= max_attempts
               THEN '{"code":"attempts_exhausted","message":"Maximum attempts exhausted"}'::jsonb
             ELSE error
           END,
           owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE status = 'running' AND lease_expires_at < $1`,
      [now]
    );
    return r.rowCount ?? 0;
  }
}
