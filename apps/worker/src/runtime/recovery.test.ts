import { describe, expect, it, vi } from "vitest";
import { externalFailure } from "@tk/contracts";
import {
  ExternalResultUnknownError,
  NeedsInputError,
  RetryableJobError,
  adaptLeasedJobRepository,
  runWorkerLoop,
  type ClaimedWorkerJob,
  type EnqueueJob,
  type ReconciliationIntent,
  type WorkerJobRepository
} from "./worker-loop.js";

type Row = EnqueueJob & {
  jobId: string;
  status: "queued" | "running" | "needs_input" | "failed" | "succeeded" | "paused";
  owner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  remoteTaskId: string | null;
  error: Record<string, unknown> | null;
  nextAttemptAt: Date | null;
};

class DurableMemoryJobs implements WorkerJobRepository {
  rows: Row[] = [];
  private id = 0;
  globalPaused = false;
  heartbeats = 0;

  async enqueue(input: EnqueueJob): Promise<string> {
    const existing = this.rows.find((row) => row.kind === input.kind && row.businessKey === input.businessKey);
    if (existing) return existing.jobId;
    const row: Row = { ...input, jobId: `job-${++this.id}`, status: "queued", owner: null, leaseToken: null, leaseExpiresAt: null, remoteTaskId: null, error: null, nextAttemptAt: null };
    this.rows.push(row);
    return row.jobId;
  }

  async releaseExpired(now: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.status !== "running" || !row.leaseExpiresAt || row.leaseExpiresAt > now) continue;
      count++;
      row.owner = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
      if (row.remoteTaskId || row.payload.reconciliationIntent !== undefined) {
        row.status = "needs_input";
        row.error = { code: "reconcile_required" };
      } else row.status = "queued";
    }
    return count;
  }

  private lease(row: Row, owner: string, now: Date, leaseMs: number): ClaimedWorkerJob {
    row.status = "running";
    row.owner = owner;
    row.leaseToken = `lease-${row.jobId}-${now.getTime()}`;
    row.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return { jobId: row.jobId, kind: row.kind, businessKey: row.businessKey, batchKey: row.batchKey, payload: row.payload, leaseToken: row.leaseToken, remoteTaskId: row.remoteTaskId };
  }

  async claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null> {
    if (this.globalPaused) return null;
    const row = this.rows.find((candidate) => candidate.status === "queued");
    return row ? this.lease(row, owner, now, leaseMs) : null;
  }

  async claimReconciliation(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null> {
    if (this.globalPaused) return null;
    const row = this.rows.find((candidate) => candidate.status === "needs_input" && candidate.error?.code === "reconcile_required" && candidate.remoteTaskId);
    return row ? this.lease(row, owner, now, leaseMs) : null;
  }

  async completeAndEnqueue(job: ClaimedWorkerJob, owner: string, now: Date, next: readonly EnqueueJob[]): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row || (row.leaseExpiresAt && row.leaseExpiresAt <= now)) return false;
    for (const item of next) await this.enqueue(item);
    row.status = "succeeded";
    row.owner = null;
    row.leaseToken = null;
    return true;
  }

  async fail(job: ClaimedWorkerJob, owner: string, _now: Date, error: Record<string, unknown>): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.status = "failed";
    row.error = error;
    row.owner = null;
    return true;
  }

  async markResultUnknown(job: ClaimedWorkerJob, owner: string, _now: Date, remoteTaskId: string, error: Record<string, unknown>): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.status = "needs_input";
    row.remoteTaskId = remoteTaskId;
    row.error = error;
    row.owner = null;
    row.leaseToken = null;
    return true;
  }

  async markNeedsInput(job: ClaimedWorkerJob, owner: string, _now: Date, error: Record<string, unknown>): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.status = "needs_input";
    row.error = error;
    row.owner = null;
    row.leaseToken = null;
    return true;
  }

  async retry(job: ClaimedWorkerJob, owner: string, now: Date, delayMs: number, error: Record<string, unknown>): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.status = "queued";
    row.error = error;
    row.nextAttemptAt = new Date(now.getTime() + delayMs);
    row.owner = null;
    row.leaseToken = null;
    return true;
  }

  async heartbeat(job: ClaimedWorkerJob, owner: string, _now: Date, _leaseMs: number): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    this.heartbeats++;
    return true;
  }

  async persistRemoteTask(job: ClaimedWorkerJob, owner: string, _now: Date, remoteTaskId: string): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.remoteTaskId = remoteTaskId;
    const { reconciliationIntent: _intent, ...payload } = row.payload;
    row.payload = payload;
    return true;
  }

  async persistReconciliationIntent(job: ClaimedWorkerJob, owner: string, _now: Date, intent: ReconciliationIntent): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.payload = { ...row.payload, reconciliationIntent: intent };
    return true;
  }

  async enqueueCompensation(job: ClaimedWorkerJob, owner: string, _now: Date, cleanup: EnqueueJob): Promise<boolean> {
    if (!this.owned(job, owner)) return false;
    await this.enqueue(cleanup);
    return true;
  }

  private owned(job: ClaimedWorkerJob, owner: string): Row | undefined {
    return this.rows.find((row) => row.jobId === job.jobId && row.owner === owner && row.leaseToken === job.leaseToken);
  }
}

const clock = { now: () => new Date("2026-07-16T00:00:00Z") };

describe("durable worker recovery", () => {
  it("forwards owner, lease token and now to every fenced repository mutation", async () => {
    const repository = {
      releaseExpired: vi.fn(async () => 0),
      claim: vi.fn(async () => null),
      claimReconciliation: vi.fn(async () => null),
      completeAndEnqueue: vi.fn(async () => true),
      fail: vi.fn(async () => true),
      markResultUnknown: vi.fn(async () => true),
      markNeedsInput: vi.fn(async () => true),
      retry: vi.fn(async () => true),
      heartbeat: vi.fn(async () => true),
      persistReconciliationIntent: vi.fn(async () => true),
      persistRemoteTask: vi.fn(async () => true),
      enqueueCompensation: vi.fn(async () => true)
    };
    const adapted = adaptLeasedJobRepository(repository);
    const claimed = { jobId: "job-1", kind: "pricing_calculate", payload: {}, leaseToken: "lease-1", remoteTaskId: null };
    const now = new Date("2026-07-16T00:00:00Z");
    await adapted.completeAndEnqueue(claimed, "owner-1", now, []);
    await adapted.fail(claimed, "owner-1", now, { code: "failed" });
    await adapted.markNeedsInput(claimed, "owner-1", now, { code: "missing" });
    await adapted.markResultUnknown(claimed, "owner-1", now, "remote-1", { code: "unknown" });
    await adapted.retry(claimed, "owner-1", now, 1_000, { code: "retry" });
    await adapted.heartbeat(claimed, "owner-1", now, 30_000);
    const intent = { version: 1 as const, operation: "canvas_submit", idempotencyKey: "canvas:rev:1" };
    await adapted.persistReconciliationIntent(claimed, "owner-1", now, intent);
    await adapted.persistRemoteTask(claimed, "owner-1", now, "remote-2");
    await adapted.enqueueCompensation(claimed, "owner-1", now, { kind: "staging_cleanup", businessKey: "cleanup-1", payload: {} });
    expect(repository.completeAndEnqueue).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, []);
    expect(repository.fail).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, { code: "failed" });
    expect(repository.markNeedsInput).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, { code: "missing" });
    expect(repository.markResultUnknown).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, "remote-1", { code: "unknown" });
    expect(repository.retry).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, 1_000, { code: "retry" });
    expect(repository.heartbeat).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, 30_000);
    expect(repository.persistReconciliationIntent).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, intent);
    expect(repository.persistRemoteTask).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, "remote-2");
    expect(repository.enqueueCompensation).toHaveBeenCalledWith("job-1", "owner-1", "lease-1", now, { kind: "staging_cleanup", businessKey: "cleanup-1", payload: {} });
  });

  it("continues the persisted DAG after a brand-new runtime instance", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "asset_archive", businessKey: "rev-1:archive", payload: { revisionId: "rev-1" } });
    const order: string[] = [];
    const handlers = {
      asset_archive: async () => { order.push("archive"); return { next: [{ kind: "listing_generate", businessKey: "rev-1:listing", payload: { revisionId: "rev-1" } }] }; },
      listing_generate: async () => { order.push("listing"); return { next: [{ kind: "pricing_calculate", businessKey: "rev-1:pricing", payload: { revisionId: "rev-1" } }] }; },
      pricing_calculate: async () => { order.push("pricing"); return { next: [] }; }
    };

    await runWorkerLoop({ jobs, handlers, clock, workerId: "before-restart", leaseMs: 30_000, maxJobs: 1 });
    await runWorkerLoop({ jobs, handlers, clock, workerId: "after-restart", leaseMs: 30_000, maxJobs: 10 });

    expect(order).toEqual(["archive", "listing", "pricing"]);
    expect(jobs.rows.every((row) => row.status === "succeeded")).toBe(true);
  });

  it("fails one product without stopping a sibling job", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "listing_generate", businessKey: "bad", payload: { revisionId: "bad" } });
    await jobs.enqueue({ kind: "listing_generate", businessKey: "good", payload: { revisionId: "good" } });
    const completed: string[] = [];
    await runWorkerLoop({
      jobs,
      handlers: { listing_generate: async (job) => {
        if (job.payload.revisionId === "bad") throw new Error("bad product");
        completed.push(String(job.payload.revisionId));
        return { next: [] };
      } },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 2
    });
    expect(completed).toEqual(["good"]);
    expect(jobs.rows.map((row) => row.status)).toEqual(["failed", "succeeded"]);
    expect(JSON.stringify(jobs.rows[0]?.error)).not.toContain("bad product");
    expect(jobs.rows[0]?.error).toMatchObject({
      kind: "fatal",
      code: "worker.handler_failed",
      safeMessage: "Worker handler failed"
    });
  });

  it("reconciles a persisted Canvas remote id after restart without submitting twice", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "canvas_generate", businessKey: "canvas:rev-1", payload: { revisionId: "rev-1" } });
    let submits = 0;
    let fetches = 0;
    const firstHandlers = {
      canvas_generate: async () => {
        submits++;
        throw new ExternalResultUnknownError("remote-canvas-1", "process stopped after submit");
      }
    };
    await runWorkerLoop({ jobs, handlers: firstHandlers, clock, workerId: "old", leaseMs: 30_000, maxJobs: 1 });

    await runWorkerLoop({
      jobs,
      handlers: { canvas_generate: async (job) => {
        expect(job.remoteTaskId).toBe("remote-canvas-1");
        fetches++;
        return { next: [] };
      } },
      clock,
      workerId: "new",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect({ submits, fetches }).toEqual({ submits: 1, fetches: 1 });
    expect(jobs.rows[0]?.status).toBe("succeeded");
  });

  it("stops after one failed reconciliation instead of repeatedly fetching in one runtime", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "canvas_generate", businessKey: "canvas:bounded-reconcile", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: { canvas_generate: async () => { throw new ExternalResultUnknownError("remote-bounded", "submitted"); } },
      clock,
      workerId: "submitter",
      leaseMs: 30_000,
      maxJobs: 1
    });
    let fetches = 0;
    await runWorkerLoop({
      jobs,
      handlers: { canvas_generate: async () => {
        fetches++;
        throw new ExternalResultUnknownError("remote-bounded", "fetch failed");
      } },
      clock,
      workerId: "reconciler",
      leaseMs: 30_000,
      maxJobs: 3
    });
    expect(fetches).toBe(1);
    expect(jobs.rows[0]).toMatchObject({
      status: "needs_input",
      error: {
        kind: "reconcile_required",
        code: "reconcile_failed"
      }
    });
  });

  it("observes a persisted global pause rather than a runtime flag", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "pricing_calculate", businessKey: "paused", payload: {} });
    jobs.globalPaused = true;
    const calls: string[] = [];
    const handlers = { pricing_calculate: async () => { calls.push("called"); return { next: [] }; } };
    await runWorkerLoop({ jobs, handlers, clock, workerId: "paused-worker", leaseMs: 30_000, maxJobs: 1 });
    expect(calls).toEqual([]);
    jobs.globalPaused = false;
    await runWorkerLoop({ jobs, handlers, clock, workerId: "resumed-worker", leaseMs: 30_000, maxJobs: 1 });
    expect(calls).toEqual(["called"]);
  });

  it("persists a needs-input outcome instead of treating it as a safe retry", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "pricing_calculate", businessKey: "missing-weight", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: { pricing_calculate: async () => { throw new NeedsInputError("missing_weight", "Weight is required"); } },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(jobs.rows[0]).toMatchObject({
      status: "needs_input",
      error: {
        kind: "needs_input",
        code: "missing_weight"
      }
    });
  });

  it("persists retry backoff instead of spinning in process memory", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "listing_generate", businessKey: "retryable", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: { listing_generate: async () => { throw new RetryableJobError("llm_timeout", "Temporary timeout", 5_000); } },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(jobs.rows[0]).toMatchObject({
      status: "queued",
      error: {
        kind: "retryable",
        code: "llm_timeout"
      },
      nextAttemptAt: new Date("2026-07-16T00:00:05Z")
    });
  });

  it("retries a classified external failure after the default 30 second delay", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "canvas_generate", businessKey: "canvas-capacity-network", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: {
        canvas_generate: async () => {
          throw externalFailure("retryable", "canvas.network", "Canvas is temporarily unavailable");
        }
      },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(jobs.rows[0]).toMatchObject({
      status: "queued",
      error: {
        kind: "retryable",
        code: "canvas.network",
        safeMessage: "Canvas is temporarily unavailable"
      },
      nextAttemptAt: new Date("2026-07-16T00:00:30Z")
    });
  });

  it.each([
    ["needs_input", "needs_input"],
    ["reconcile_required", "needs_input"],
    ["fatal", "failed"]
  ] as const)("persists a classified %s external failure without unsafe retry", async (kind, status) => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "canvas_generate", businessKey: `canvas-${kind}`, payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: {
        canvas_generate: async () => {
          throw externalFailure(kind, `canvas.${kind}`, `Safe ${kind} message`);
        }
      },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(jobs.rows[0]).toMatchObject({
      status,
      error: {
        kind,
        code: `canvas.${kind}`,
        safeMessage: `Safe ${kind} message`
      },
      nextAttemptAt: null
    });
  });

  it("renews the fenced lease while a handler is still running", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "asset_archive", businessKey: "long", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: { asset_archive: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { next: [] };
      } },
      clock: { now: () => new Date() },
      workerId: "worker",
      leaseMs: 9,
      maxJobs: 1
    });
    expect(jobs.heartbeats).toBeGreaterThan(0);
  });

  it("aborts the handler and performs no terminal write after heartbeat loses the lease", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "asset_archive", businessKey: "lost", batchKey: "batch-1", payload: {} });
    jobs.heartbeat = vi.fn(async () => false);
    const persisted = vi.fn();
    await runWorkerLoop({
      jobs,
      handlers: { asset_archive: async (_job, execution) => {
        await new Promise<void>((resolve) => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
        execution.assertLease();
        persisted();
        return { next: [] };
      } },
      clock: { now: () => new Date() },
      workerId: "worker",
      leaseMs: 9,
      maxJobs: 1
    });
    expect(persisted).not.toHaveBeenCalled();
    expect(jobs.rows[0]).toMatchObject({ status: "running", batchKey: "batch-1" });
  });

  it("propagates the claimed batch key to every next DAG node", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "pricing_calculate", businessKey: "pricing", batchKey: "batch-9", payload: {} });
    await runWorkerLoop({
      jobs,
      handlers: { pricing_calculate: async () => ({ next: [{ kind: "template_match", businessKey: "template", payload: {} }] }) },
      clock,
      workerId: "worker",
      leaseMs: 30_000,
      maxJobs: 1
    });
    expect(jobs.rows.find((row) => row.kind === "template_match")?.batchKey).toBe("batch-9");
  });

  it("honors configured workspace worker concurrency", async () => {
    const jobs = new DurableMemoryJobs();
    await jobs.enqueue({ kind: "listing_generate", businessKey: "one", payload: {} });
    await jobs.enqueue({ kind: "listing_generate", businessKey: "two", payload: {} });
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = runWorkerLoop({
      jobs,
      handlers: { listing_generate: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (maximumActive === 2) release();
        await gate;
        active--;
        return { next: [] };
      } },
      clock: { now: () => new Date() },
      workerId: "worker",
      leaseMs: 30_000,
      workerConcurrency: 2,
      maxJobs: 2
    });
    await run;
    expect(maximumActive).toBe(2);
  });
});
