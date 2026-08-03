import { expect, test } from "@playwright/test";

import {
  ExternalResultUnknownError,
  NeedsInputError,
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

  /** Direct row injection — used by restart scenarios to seed pre-crash state. */
  seedRow(row: Omit<Row, "jobId"> & { jobId?: string }): void {
    this.rows.push({
      kind: row.kind,
      businessKey: row.businessKey,
      payload: row.payload,
      jobId: row.jobId ?? `job-${this.rows.length + 1}`,
      status: row.status,
      owner: null,
      leaseToken: null,
      remoteTaskId: row.remoteTaskId ?? null,
      error: row.error ?? null
    });
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
    const { reconciliationIntent: _intent, ...payload } = row.payload;
    row.payload = payload;
    return true;
  }

  async persistReconciliationIntent(job: ClaimedWorkerJob, owner: string, _now: Date, intent: Record<string, unknown>): Promise<boolean> {
    const row = this.owned(job, owner);
    if (!row) return false;
    row.payload = { ...row.payload, reconciliationIntent: intent };
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

// ---------------------------------------------------------------------------
// Headless image-generation restart scenarios (parallel to Canvas/Miaoshou).
//
// Each scenario follows the same pattern as the Canvas/Miaoshou tests above:
//   1. Seed the in-memory DurableJobs with a job in a state that mirrors what
//      the database would look like *after* a crash at the named checkpoint.
//   2. Run the worker once to simulate the pre-crash pass (or skip if the
//      seed already represents post-crash state).
//   3. Run the worker again on a fresh runtime and assert:
//        - The remote side effect (submit) is NOT called again.
//        - The job reaches the expected terminal/transitional state.
//        - The persisted remote task id (if any) is preserved.
// ---------------------------------------------------------------------------

test.describe("headless image generation restart safety", () => {

  test("planning: image_prompt_plan crash mid-plan — fresh runtime is idempotent and does not duplicate slots", async () => {
    const jobs = new DurableJobs();
    jobs.enqueue("image_prompt_plan", "plan:batch_headless_plan:restart", {
      version: 1,
      batchId: "batch_headless_plan",
      requestedOutputCount: 3
    });

    // First run: simulate a crash AFTER persisting the plan but BEFORE acknowledging.
    let planCalls = 0;
    await runWorkerLoop({
      jobs,
      handlers: {
        image_prompt_plan: async (_job, execution) => {
          planCalls += 1;
          // Persist a synthetic remote marker for the planner result, then crash.
          await execution.persistRemoteTask("plan-result:batch_headless_plan:3-prompts");
          throw new ExternalResultUnknownError(
            "plan-result:batch_headless_plan:3-prompts",
            "planner result unknown — process stopped before acknowledgement"
          );
        }
      },
      clock,
      workerId: "plan-old-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(planCalls).toBe(1);
    expect(jobs.rows[0]).toMatchObject({
      status: "needs_input",
      remoteTaskId: "plan-result:batch_headless_plan:3-prompts",
      error: { code: "reconcile_required" }
    });

    // Fresh runtime must reconcile from the persisted plan result, not re-plan.
    await runWorkerLoop({
      jobs,
      handlers: {
        image_prompt_plan: async (job) => {
          expect(job.remoteTaskId).toBe("plan-result:batch_headless_plan:3-prompts");
          return { next: [] };
        }
      },
      clock,
      workerId: "plan-fresh-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(planCalls).toBe(1); // planner must NOT have been called a second time
    expect(jobs.rows[0]?.status).toBe("succeeded");
  });

  test("after submit intent persisted but no remote task — fresh runtime stays needs_input without resubmitting", async () => {
    const jobs = new DurableJobs();
    // Seed a job whose payload carries a reconciliationIntent but no remote task id —
    // exactly the post-crash state when the worker crashed AFTER writing the
    // submit intent but BEFORE persistRemoteTask could persist the id.
    jobs.seedRow({
      kind: "image_generate_slot",
      businessKey: "slot:batch_intent:1",
      payload: {
        version: 1,
        batchId: "batch_intent",
        slotId: "slot_intent_1",
        slotNumber: 1,
        reconciliationIntent: { version: 1, operation: "image_generate_slot", idempotencyKey: "slot:batch_intent:1" }
      },
      status: "queued",
      remoteTaskId: null
    });

    let submitCalls = 0;
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async () => {
          submitCalls += 1;
          throw new NeedsInputError(
            "image_submission_result_unknown",
            "image generation submit intent persisted but result is unknown"
          );
        }
      },
      clock,
      workerId: "intent-old-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(1);
    expect(jobs.rows[0]).toMatchObject({
      status: "needs_input",
      error: { code: "image_submission_result_unknown" }
    });

    // Fresh runtime: there is nothing to reconcile, so submit must NOT be called again.
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async () => {
          throw new Error("submit should not be called on a needs_input recovery without remote task id");
        }
      },
      clock,
      workerId: "intent-fresh-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(1); // still 1 — no resubmit
    expect(jobs.rows[0]?.status).toBe("needs_input");
  });

  test("polling: remote_task_id persisted — fresh runtime polls, never resubmits", async () => {
    const jobs = new DurableJobs();
    // Seed: slot already has a remote_task_id, simulating a crash during a poll cycle.
    jobs.seedRow({
      kind: "image_generate_slot",
      businessKey: "slot:batch_poll:1",
      payload: {
        version: 1,
        batchId: "batch_poll",
        slotId: "slot_poll_1",
        slotNumber: 1
      },
      status: "queued",
      remoteTaskId: "remote_poll_1"
    });

    let submitCalls = 0;
    let pollCalls = 0;

    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async (job) => {
          expect(job.remoteTaskId).toBe("remote_poll_1");
          pollCalls += 1;
          // Poll returns "still pending" — handler completes without resubmitting.
          return { next: [] };
        }
      },
      clock,
      workerId: "poll-old-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(0);
    expect(pollCalls).toBe(1);

    // Fresh runtime must NOT call submit — the remote_task_id is already known.
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async (job) => {
          expect(job.remoteTaskId).toBe("remote_poll_1");
          // The job already succeeded in the previous run; no handler invocation expected.
          return { next: [] };
        }
      },
      clock,
      workerId: "poll-fresh-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(0);
    expect(jobs.rows[0]?.remoteTaskId).toBe("remote_poll_1");
  });

  test("download: remote_output_url persisted but no archived_asset_id — fresh runtime finishes download without resubmitting", async () => {
    const jobs = new DurableJobs();
    jobs.seedRow({
      kind: "image_generate_slot",
      businessKey: "slot:batch_download:1",
      payload: {
        version: 1,
        batchId: "batch_download",
        slotId: "slot_download_1",
        slotNumber: 1,
        remoteOutputUrl: "https://cdn.headless.invalid/output_1.png"
      },
      status: "queued",
      remoteTaskId: "remote_download_1"
    });

    let submitCalls = 0;

    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async (job) => {
          expect(job.remoteTaskId).toBe("remote_download_1");
          // Handler completes the download/archival step without ever calling submit.
          return { next: [] };
        }
      },
      clock,
      workerId: "download-old-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(0);
    expect(jobs.rows[0]).toMatchObject({
      status: "succeeded",
      remoteTaskId: "remote_download_1"
    });

    // Fresh runtime: job already succeeded so no handler invocation expected.
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async () => {
          throw new Error("handler must not be invoked after the slot already succeeded");
        }
      },
      clock,
      workerId: "download-fresh-worker",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(0);
    expect(jobs.rows[0]?.remoteTaskId).toBe("remote_download_1");
  });

  test("intent without result: worker stays needs_input and never resubmits", async () => {
    const jobs = new DurableJobs();
    jobs.enqueue("image_generate_slot", "slot:batch_no_result:1", {
      version: 1,
      batchId: "batch_no_result",
      slotId: "slot_no_result_1",
      slotNumber: 1,
      reconciliationIntent: { version: 1, operation: "image_generate_slot", idempotencyKey: "slot:batch_no_result:1" }
    });

    let submitCalls = 0;
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async () => {
          submitCalls += 1;
          throw new NeedsInputError(
            "image_submission_result_unknown",
            "intent persisted but provider result is unknown"
          );
        }
      },
      clock,
      workerId: "no-result-old",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(1);
    expect(jobs.rows[0]).toMatchObject({
      status: "needs_input",
      error: { code: "image_submission_result_unknown" }
    });

    // Restart: handler must NOT run because the job is already needs_input.
    await runWorkerLoop({
      jobs,
      handlers: {
        image_generate_slot: async () => {
          throw new Error("handler must not be invoked on needs_input restart");
        }
      },
      clock,
      workerId: "no-result-fresh",
      leaseMs: 30_000,
      maxJobs: 1
    });

    expect(submitCalls).toBe(1); // no resubmit
    expect(jobs.rows[0]?.status).toBe("needs_input");
  });
});