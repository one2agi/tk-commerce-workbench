import { expect, test } from "@playwright/test";

import {
  ExternalResultUnknownError,
  runWorkerLoop,
  type ClaimedWorkerJob,
  type EnqueueJob,
  type WorkerJobRepository
} from "../apps/worker/src/runtime/worker-loop.js";

type Row = EnqueueJob & {
  jobId: string;
  status: "queued" | "running" | "needs_input" | "failed" | "succeeded";
  owner: string | null;
  leaseToken: string | null;
  remoteTaskId: string | null;
  error: Record<string, unknown> | null;
};

class DurableJobs implements WorkerJobRepository {
  readonly rows: Row[] = [];

  enqueue(kind: string, businessKey: string, payload: Record<string, unknown> = {}): void {
    this.rows.push({ kind, businessKey, payload, jobId: `job-${this.rows.length + 1}`, status: "queued", owner: null, leaseToken: null, remoteTaskId: null, error: null });
  }

  async releaseExpired(): Promise<number> { return 0; }

  private lease(row: Row, owner: string): ClaimedWorkerJob {
    row.status = "running";
    row.owner = owner;
    row.leaseToken = `lease:${owner}:${row.jobId}`;
    return { jobId: row.jobId, kind: row.kind, businessKey: row.businessKey, payload: row.payload, leaseToken: row.leaseToken, remoteTaskId: row.remoteTaskId };
  }

  async claim(owner: string): Promise<ClaimedWorkerJob | null> {
    const row = this.rows.find((candidate) => candidate.status === "queued");
    return row ? this.lease(row, owner) : null;
  }

  async claimReconciliation(owner: string): Promise<ClaimedWorkerJob | null> {
    const row = this.rows.find((candidate) => candidate.status === "needs_input" && candidate.error?.code === "reconcile_required" && candidate.remoteTaskId);
    return row ? this.lease(row, owner) : null;
  }

  async completeAndEnqueue(job: ClaimedWorkerJob, owner: string): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
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
    return true;
  }

  async retry(): Promise<boolean> { return false; }
  async heartbeat(job: ClaimedWorkerJob, owner: string): Promise<boolean> { return Boolean(this.owned(job, owner)); }

  async persistRemoteTask(job: ClaimedWorkerJob, owner: string, _now: Date, remoteTaskId: string): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.remoteTaskId = remoteTaskId;
    return true;
  }

  async enqueueCompensation(): Promise<boolean> { return true; }

  private owned(job: ClaimedWorkerJob, owner: string): Row | undefined {
    return this.rows.find((row) => row.jobId === job.jobId && row.owner === owner && row.leaseToken === job.leaseToken);
  }
}

const clock = { now: () => new Date("2026-07-16T00:00:00Z") };

async function proveFreshRuntimeReconciles(input: { kind: string; remoteMarker: string }) {
  const jobs = new DurableJobs();
  jobs.enqueue(input.kind, `${input.kind}:approved-revision`, { approvalSnapshotId: "approval-current" });
  let submissions = 0;
  let reconciliations = 0;

  await runWorkerLoop({
    jobs,
    handlers: {
      [input.kind]: async (_job, execution) => {
        submissions += 1;
        await execution.persistRemoteTask(input.remoteMarker);
        throw new ExternalResultUnknownError(input.remoteMarker, "simulated process crash after remote acceptance");
      }
    },
    clock,
    workerId: "runtime-before-crash",
    leaseMs: 30_000,
    maxJobs: 1
  });

  expect(jobs.rows[0]).toMatchObject({ status: "needs_input", remoteTaskId: input.remoteMarker, error: { code: "reconcile_required" } });

  await runWorkerLoop({
    jobs,
    handlers: {
      [input.kind]: async (job) => {
        expect(job.remoteTaskId).toBe(input.remoteMarker);
        reconciliations += 1;
        return { next: [] };
      }
    },
    clock,
    workerId: "fresh-runtime-after-crash",
    leaseMs: 30_000,
    maxJobs: 1
  });

  expect({ submissions, reconciliations, state: jobs.rows[0]?.status }).toEqual({ submissions: 1, reconciliations: 1, state: "succeeded" });
}

test("Canvas 已保存 remote task 后崩溃，fresh runtime 只查询产物而不重复生图", async () => {
  await proveFreshRuntimeReconciles({ kind: "canvas_generate", remoteMarker: "canvas-task:TK:once" });
});

test("妙手已接受 canonical edit 后崩溃，fresh runtime 只核对同一详情且不重复写入", async () => {
  await proveFreshRuntimeReconciles({ kind: "miaoshou_edit", remoteMarker: "canonical:3799770548" });
});
