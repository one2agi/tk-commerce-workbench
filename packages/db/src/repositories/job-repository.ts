// Durable job repository. A random lease token fences each claim, so a worker whose
// lease expired cannot overwrite the result produced by a newer owner.

import { strict as assert } from "node:assert";

import { schema, type DbPool } from "../schema/index.js";
import { appendAuditInTransaction, assertSafeAuditPayload, type TransactionAuditMetadata } from "./audit-repository.js";

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
  batchKey?: string;
  audit?: TransactionAuditMetadata;
}

export interface ClaimedJob {
  jobId: string;
  kind: string;
  businessKey: string;
  batchKey?: string;
  payload: Record<string, unknown>;
  leaseToken: string;
  remoteTaskId: string | null;
}

export class JobRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async enqueue(input: JobClaimInput): Promise<string> {
    assert(input.kind.length > 0, "kind required");
    assert(input.businessKey.length > 0, "businessKey required");
    if (input.audit) assertSafeAuditPayload(input.audit.payload ?? {});
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const max = input.maxAttempts ?? 3;
      const id = newId("job");
      const idemKey = input.idempotencyKey ?? input.businessKey;
      const ins = await client.query<{ id: string }>(
        `INSERT INTO ${schema.jobs}
          (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7)
         ON CONFLICT (kind, business_key) DO NOTHING
         RETURNING id`,
        [id, input.kind, input.businessKey, idemKey, JSON.stringify(input.payload), max, input.batchKey ?? null]
      );
      let jobId = ins.rows[0]?.id;
      if (!jobId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM ${schema.jobs} WHERE kind = $1 AND business_key = $2`,
          [input.kind, input.businessKey]
        );
        assert(existing.rows[0], "conflicting job must exist");
        jobId = existing.rows[0].id;
      }
      if (input.audit) await appendAuditInTransaction(client, input.audit, jobId);
      await client.query("COMMIT");
      return jobId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
        business_key: string;
        batch_key: string | null;
        payload: Record<string, unknown>;
        lease_token: string;
        remote_task_id: string | null;
      }>(
        `WITH candidate AS (
           SELECT id FROM ${schema.jobs}
           WHERE status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM ${schema.workspaceSettings} WHERE worker_paused = true
             )
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
         RETURNING j.id, j.kind, j.business_key, j.batch_key, j.payload, j.lease_token, j.remote_task_id`,
        [owner, now, leaseExpiresAt, leaseToken]
      );
      if (updated.rowCount === 0) return null;
      const row = updated.rows[0];
      assert(row, "claimed job must be returned");
      return {
        jobId: row.id,
        kind: row.kind,
        businessKey: row.business_key,
        batchKey: row.batch_key ?? undefined,
        payload: row.payload ?? {},
        leaseToken: row.lease_token,
        remoteTaskId: row.remote_task_id
      };
    } finally {
      client.release();
    }
  }

  async claimReconciliation(owner: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const leaseToken = newId("lease");
    const result = await this.pool.query<{
      id: string;
      kind: string;
      business_key: string;
      batch_key: string | null;
      payload: Record<string, unknown>;
      lease_token: string;
      remote_task_id: string | null;
    }>(
      `WITH candidate AS (
         SELECT id FROM ${schema.jobs}
         WHERE status = 'needs_input'
           AND error->>'code' = 'reconcile_required'
           AND remote_task_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${schema.workspaceSettings} WHERE worker_paused = true)
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE ${schema.jobs} j
       SET status = 'running', owner = $1, lease_token = $2,
           lease_expires_at = $3::timestamptz, last_heartbeat_at = $4::timestamptz,
           updated_at = now()
       FROM candidate WHERE j.id = candidate.id
       RETURNING j.id, j.kind, j.business_key, j.batch_key, j.payload, j.lease_token, j.remote_task_id`,
      [owner, leaseToken, leaseExpiresAt, now]
    );
    const row = result.rows[0];
    return row ? {
      jobId: row.id,
      kind: row.kind,
      businessKey: row.business_key,
      batchKey: row.batch_key ?? undefined,
      payload: row.payload ?? {},
      leaseToken: row.lease_token,
      remoteTaskId: row.remote_task_id
    } : null;
  }

  async completeAndEnqueue(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    next: readonly JobClaimInput[]
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        `UPDATE ${schema.jobs}
         SET status = 'succeeded', owner = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
           AND lease_expires_at > $4::timestamptz
         RETURNING id`,
        [jobId, owner, leaseToken, now]
      );
      if ((completed.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const input of next) {
        await client.query(
          `INSERT INTO ${schema.jobs}
           (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7)
           ON CONFLICT (kind, business_key) DO NOTHING`,
          [newId("job"), input.kind, input.businessKey, input.idempotencyKey ?? input.businessKey, JSON.stringify(input.payload), input.maxAttempts ?? 3, input.batchKey ?? null]
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markResultUnknown(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    remoteTaskId: string,
    error: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'needs_input', remote_task_id = $5, error = $6::jsonb,
           owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now, remoteTaskId, JSON.stringify(error)]
    );
    return result.rowCount === 1;
  }

  async persistRemoteTask(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    remoteTaskId: string
  ): Promise<boolean> {
    assert(remoteTaskId.length > 0, "remoteTaskId required");
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET remote_task_id = $5, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now, remoteTaskId]
    );
    return result.rowCount === 1;
  }

  async enqueueCompensation(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    cleanup: JobClaimInput & { delayMs?: number }
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owned = await client.query(
        `SELECT id FROM ${schema.jobs}
         WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
           AND lease_expires_at > $4::timestamptz
         FOR UPDATE`,
        [jobId, owner, leaseToken, now]
      );
      if ((owned.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO ${schema.jobs}
         (id, kind, business_key, idempotency_key, payload, status, max_attempts, batch_key, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8::timestamptz)
         ON CONFLICT (kind, business_key) DO NOTHING`,
        [newId("job"), cleanup.kind, cleanup.businessKey, cleanup.idempotencyKey ?? cleanup.businessKey,
          JSON.stringify(cleanup.payload), cleanup.maxAttempts ?? 3, cleanup.batchKey ?? null,
          new Date(now.getTime() + (cleanup.delayMs ?? 0))]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markNeedsInput(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    error: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'needs_input', error = $5::jsonb, owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now, JSON.stringify(error)]
    );
    return result.rowCount === 1;
  }

  async setGlobalPaused(paused: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${schema.workspaceSettings} (id, worker_paused)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET worker_paused = EXCLUDED.worker_paused`,
      [paused]
    );
  }

  async pauseBatch(batchKey: string, reason: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs} SET status = 'paused', pause_reason = $2, updated_at = now()
       WHERE batch_key = $1 AND status = 'queued'`,
      [batchKey, reason]
    );
    return result.rowCount ?? 0;
  }

  async resumeBatch(batchKey: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs} SET status = 'queued', pause_reason = NULL, updated_at = now()
       WHERE batch_key = $1 AND status = 'paused'`,
      [batchKey]
    );
    return result.rowCount ?? 0;
  }

  async cancel(jobId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'failed', error = $2::jsonb, owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, pause_reason = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'paused', 'needs_input', 'failed')`,
      [jobId, JSON.stringify({ code: "cancelled", safeMessage: reason })]
    );
    return result.rowCount === 1;
  }

  async retrySafe(jobId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'queued', error = NULL, next_attempt_at = $2::timestamptz,
           pause_reason = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'needs_input')
         AND remote_task_id IS NULL
         AND COALESCE(error->>'code', '') <> 'reconcile_required'
         AND attempt < max_attempts`,
      [jobId, now]
    );
    return result.rowCount === 1;
  }

  async retry(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    delayMs: number,
    error: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
           next_attempt_at = CASE WHEN attempt >= max_attempts THEN NULL ELSE $5::timestamptz END,
           error = CASE WHEN attempt >= max_attempts
             THEN '{"code":"attempts_exhausted","safeMessage":"Maximum attempts exhausted"}'::jsonb
             ELSE $6::jsonb END,
           owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now, new Date(now.getTime() + delayMs), JSON.stringify(error)]
    );
    return result.rowCount === 1;
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
       WHERE id = $1 AND status = 'running' AND owner = $4 AND lease_token = $5
         AND lease_expires_at > $2::timestamptz`,
      [jobId, now, new Date(now.getTime() + leaseMs), owner, leaseToken]
    );
    return result.rowCount === 1;
  }

  async complete(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'succeeded', owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now]
    );
    return result.rowCount === 1;
  }

  async fail(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    error: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${schema.jobs}
       SET status = 'failed', error = $5::jsonb, owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 AND lease_token = $3
         AND lease_expires_at > $4::timestamptz`,
      [jobId, owner, leaseToken, now, JSON.stringify(error)]
    );
    return result.rowCount === 1;
  }

  async releaseExpired(now: Date): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const released = await client.query<{ id: string }>(
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
       WHERE status = 'running' AND lease_expires_at <= $1
       RETURNING id`,
        [now]
      );
      const releasedIds = released.rows.map((row) => row.id);
      if (releasedIds.length > 0) {
        await client.query(
          `UPDATE ${schema.miaoshouSyncs} sync
           SET state = 'result_unknown',
               error = '{"code":"reconcile_required","message":"Miaoshou edit lease expired; reconcile remote result"}'::jsonb,
               updated_at = now()
           WHERE sync.approval_snapshot_id IN (
             SELECT payload->>'approvalSnapshotId'
             FROM ${schema.jobs}
             WHERE id = ANY($1::text[]) AND kind = 'miaoshou_edit'
           )
             AND sync.state IN ('queued', 'syncing', 'result_unknown')`,
          [releasedIds]
        );
      }
      await client.query("COMMIT");
      return released.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
