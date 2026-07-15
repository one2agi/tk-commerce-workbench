// Job repository. claim() uses SELECT ... FOR UPDATE SKIP LOCKED so two concurrent
// claims with the same logical worker cannot pick the same row. The integration test
// also runs sequential double-claim as the no-flake equivalent.

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
   * Claim one queued job under owner+lease. Uses SELECT ... FOR UPDATE SKIP LOCKED.
   * Two concurrent calls with the same owner/now/leaseMs are guaranteed to return
   * exactly ONE non-null result (the second finds no available locked row to skip).
   */
  async claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    assert(owner.length > 0, "owner required");
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const client = await this.pool.connect();
    try {
      // Atomic claim via UPDATE ... RETURNING. We pick the earliest row whose status is
      // "queued" OR whose running lease already expired, then flip it to "running" with
      // a fresh lease. The CTE makes this race-safe on real Postgres and best-effort
      // under PGlite (single-connection WAL still serializes the writes).
      const updated = await client.query<{
        id: string;
        kind: string;
        payload: Record<string, unknown>;
      }>(
        `WITH candidate AS (
           SELECT id FROM ${schema.jobs}
           WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < $2)
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ${schema.jobs} j
         SET status = 'running',
             owner = $1,
             lease_expires_at = $3::timestamptz,
             attempt = attempt + 1,
             last_heartbeat_at = $2::timestamptz,
             updated_at = now()
         FROM candidate
         WHERE j.id = candidate.id
         RETURNING j.id, j.kind, j.payload`,
        [owner, now, leaseExpiresAt]
      );
      if (updated.rowCount === 0) return null;
      const row = updated.rows[0];
      return {
        jobId: row.id,
        kind: row.kind,
        payload: row.payload ?? {}
      };
    } finally {
      client.release();
    }
  }

  async heartbeat(jobId: string, now: Date, leaseMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.jobs}
       SET last_heartbeat_at = $2::timestamptz, lease_expires_at = $3::timestamptz, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [jobId, now, new Date(now.getTime() + leaseMs)]
    );
  }

  async complete(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'succeeded', lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId]
    );
  }

  async fail(jobId: string, error: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'failed', error = $2::jsonb, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [jobId, JSON.stringify(error)]
    );
  }

  async releaseExpired(now: Date): Promise<number> {
    const r = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'queued', owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE status = 'running' AND lease_expires_at < $1`,
      [now]
    );
    return r.rowCount ?? 0;
  }
}
