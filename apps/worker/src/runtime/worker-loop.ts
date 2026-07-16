export interface EnqueueJob {
  kind: string;
  businessKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  batchKey?: string;
  delayMs?: number;
}

export interface ClaimedWorkerJob {
  jobId: string;
  kind: string;
  businessKey?: string;
  batchKey?: string;
  payload: Record<string, unknown>;
  leaseToken: string;
  remoteTaskId: string | null;
}

export interface WorkerJobRepository {
  releaseExpired(now: Date): Promise<number>;
  claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null>;
  claimReconciliation(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null>;
  completeAndEnqueue(
    job: ClaimedWorkerJob,
    owner: string,
    now: Date,
    next: readonly EnqueueJob[]
  ): Promise<boolean>;
  fail(job: ClaimedWorkerJob, owner: string, now: Date, error: Record<string, unknown>): Promise<boolean>;
  markResultUnknown(
    job: ClaimedWorkerJob,
    owner: string,
    now: Date,
    remoteTaskId: string,
    error: Record<string, unknown>
  ): Promise<boolean>;
  markNeedsInput(
    job: ClaimedWorkerJob,
    owner: string,
    now: Date,
    error: Record<string, unknown>
  ): Promise<boolean>;
  retry(
    job: ClaimedWorkerJob,
    owner: string,
    now: Date,
    delayMs: number,
    error: Record<string, unknown>
  ): Promise<boolean>;
  heartbeat(job: ClaimedWorkerJob, owner: string, now: Date, leaseMs: number): Promise<boolean>;
  persistRemoteTask(job: ClaimedWorkerJob, owner: string, now: Date, remoteTaskId: string): Promise<boolean>;
  persistReconciliationIntent(
    job: ClaimedWorkerJob,
    owner: string,
    now: Date,
    intent: ReconciliationIntent
  ): Promise<boolean>;
  enqueueCompensation(job: ClaimedWorkerJob, owner: string, now: Date, cleanup: EnqueueJob): Promise<boolean>;
}

export interface LeasedJobRepository {
  releaseExpired(now: Date): Promise<number>;
  claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null>;
  claimReconciliation(owner: string, now: Date, leaseMs: number): Promise<ClaimedWorkerJob | null>;
  completeAndEnqueue(jobId: string, owner: string, leaseToken: string, now: Date, next: readonly EnqueueJob[]): Promise<boolean>;
  fail(jobId: string, owner: string, leaseToken: string, now: Date, error: Record<string, unknown>): Promise<boolean>;
  markResultUnknown(jobId: string, owner: string, leaseToken: string, now: Date, remoteTaskId: string, error: Record<string, unknown>): Promise<boolean>;
  markNeedsInput(jobId: string, owner: string, leaseToken: string, now: Date, error: Record<string, unknown>): Promise<boolean>;
  retry(jobId: string, owner: string, leaseToken: string, now: Date, delayMs: number, error: Record<string, unknown>): Promise<boolean>;
  heartbeat(jobId: string, owner: string, leaseToken: string, now: Date, leaseMs: number): Promise<boolean>;
  persistRemoteTask(jobId: string, owner: string, leaseToken: string, now: Date, remoteTaskId: string): Promise<boolean>;
  persistReconciliationIntent(
    jobId: string,
    owner: string,
    leaseToken: string,
    now: Date,
    intent: ReconciliationIntent
  ): Promise<boolean>;
  enqueueCompensation(jobId: string, owner: string, leaseToken: string, now: Date, cleanup: EnqueueJob): Promise<boolean>;
}

export function adaptLeasedJobRepository(repository: LeasedJobRepository): WorkerJobRepository {
  return {
    releaseExpired: (now) => repository.releaseExpired(now),
    claim: (owner, now, leaseMs) => repository.claim(owner, now, leaseMs),
    claimReconciliation: (owner, now, leaseMs) => repository.claimReconciliation(owner, now, leaseMs),
    completeAndEnqueue: (job, owner, now, next) => repository.completeAndEnqueue(job.jobId, owner, job.leaseToken, now, next),
    fail: (job, owner, now, error) => repository.fail(job.jobId, owner, job.leaseToken, now, error),
    markResultUnknown: (job, owner, now, remoteTaskId, error) => repository.markResultUnknown(job.jobId, owner, job.leaseToken, now, remoteTaskId, error),
    markNeedsInput: (job, owner, now, error) => repository.markNeedsInput(job.jobId, owner, job.leaseToken, now, error),
    retry: (job, owner, now, delayMs, error) => repository.retry(job.jobId, owner, job.leaseToken, now, delayMs, error),
    heartbeat: (job, owner, now, leaseMs) => repository.heartbeat(job.jobId, owner, job.leaseToken, now, leaseMs),
    persistRemoteTask: (job, owner, now, remoteTaskId) => repository.persistRemoteTask(job.jobId, owner, job.leaseToken, now, remoteTaskId),
    persistReconciliationIntent: (job, owner, now, intent) => repository.persistReconciliationIntent(job.jobId, owner, job.leaseToken, now, intent),
    enqueueCompensation: (job, owner, now, cleanup) => repository.enqueueCompensation(job.jobId, owner, job.leaseToken, now, cleanup)
  };
}

export interface HandlerResult {
  next: readonly EnqueueJob[];
}

export interface LeaseFence {
  jobId: string;
  owner: string;
  leaseToken: string;
}

export interface ReconciliationIntent extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly operation: string;
  readonly idempotencyKey: string;
}

export interface WorkerExecutionContext {
  readonly fence: LeaseFence;
  readonly signal: AbortSignal;
  assertLease(): void;
  persistReconciliationIntent(intent: ReconciliationIntent): Promise<void>;
  persistRemoteTask(remoteTaskId: string): Promise<void>;
  scheduleCompensation(cleanup: EnqueueJob): Promise<void>;
}

export type WorkerHandler = (job: ClaimedWorkerJob, execution: WorkerExecutionContext) => Promise<HandlerResult>;

export class LeaseLostError extends Error {
  constructor() {
    super("Worker lease is no longer valid");
    this.name = "LeaseLostError";
  }
}

export function requireFencedWrite(accepted: boolean): void {
  if (!accepted) throw new LeaseLostError();
}

export class ExternalResultUnknownError extends Error {
  constructor(public readonly remoteTaskId: string, message: string) {
    super(message);
    this.name = "ExternalResultUnknownError";
  }
}

export class NeedsInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NeedsInputError";
  }
}

export class RetryableJobError extends Error {
  constructor(public readonly code: string, message: string, public readonly delayMs: number) {
    super(message);
    this.name = "RetryableJobError";
  }
}

export async function runWorkerLoop(input: {
  jobs: WorkerJobRepository;
  handlers: Readonly<Record<string, WorkerHandler>>;
  clock: { now(): Date };
  workerId: string;
  leaseMs: number;
  workerConcurrency?: number;
  maxJobs?: number;
}): Promise<{ processed: number }> {
  await input.jobs.releaseExpired(input.clock.now());
  const maximum = input.maxJobs ?? Number.POSITIVE_INFINITY;
  const concurrency = input.workerConcurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("workerConcurrency must be a positive integer");
  let processed = 0;
  let claimTickets = 0;

  const runSlot = async () => {
    while (claimTickets < maximum) {
      claimTickets++;
      const now = input.clock.now();
      const job =
        await input.jobs.claimReconciliation(input.workerId, now, input.leaseMs) ??
        await input.jobs.claim(input.workerId, now, input.leaseMs);
      if (!job) break;
      processed++;
      const handler = input.handlers[job.kind];
      if (!handler) {
        await input.jobs.fail(job, input.workerId, input.clock.now(), {
          code: "worker.handler_missing",
          safeMessage: `No handler registered for ${job.kind}`
        });
        continue;
      }
      const heartbeatIntervalMs = Math.max(1, Math.floor(input.leaseMs / 3));
      let heartbeatInFlight = false;
      let leaseLost = false;
      const abortController = new AbortController();
      const loseLease = () => {
        leaseLost = true;
        abortController.abort();
      };
      const execution: WorkerExecutionContext = {
        fence: { jobId: job.jobId, owner: input.workerId, leaseToken: job.leaseToken },
        signal: abortController.signal,
        assertLease: () => {
          if (leaseLost) throw new LeaseLostError();
        },
        persistRemoteTask: async (remoteTaskId) => {
          if (leaseLost) throw new LeaseLostError();
          const persisted = await input.jobs.persistRemoteTask(job, input.workerId, input.clock.now(), remoteTaskId);
          if (!persisted) {
            loseLease();
            throw new LeaseLostError();
          }
        },
        persistReconciliationIntent: async (intent) => {
          if (leaseLost) throw new LeaseLostError();
          const persisted = await input.jobs.persistReconciliationIntent(job, input.workerId, input.clock.now(), intent);
          if (!persisted) {
            loseLease();
            throw new LeaseLostError();
          }
        },
        scheduleCompensation: async (cleanup) => {
          if (leaseLost) throw new LeaseLostError();
          const persisted = await input.jobs.enqueueCompensation(job, input.workerId, input.clock.now(), {
            ...cleanup,
            batchKey: cleanup.batchKey ?? job.batchKey
          });
          if (!persisted) {
            loseLease();
            throw new LeaseLostError();
          }
        }
      };
      const heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        void input.jobs
          .heartbeat(job, input.workerId, input.clock.now(), input.leaseMs)
          .then((renewed) => {
            if (!renewed) loseLease();
          }, () => loseLease())
          .finally(() => {
            heartbeatInFlight = false;
          });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      try {
        const result = await handler(job, execution);
        execution.assertLease();
        const next = result.next.map((item) => ({ ...item, batchKey: item.batchKey ?? job.batchKey }));
        const completed = await input.jobs.completeAndEnqueue(job, input.workerId, input.clock.now(), next);
        if (!completed) loseLease();
      } catch (error) {
        if (error instanceof LeaseLostError || leaseLost) {
          // A newer worker owns the row. The stale worker must not write any terminal state.
        } else if (error instanceof RetryableJobError) {
          await input.jobs.retry(job, input.workerId, input.clock.now(), error.delayMs, {
            code: error.code,
            safeMessage: "The operation was temporarily unavailable and will be retried"
          });
        } else if (error instanceof NeedsInputError) {
          const reconciliationRequired = error.code === "reconcile_required";
          await input.jobs.markNeedsInput(job, input.workerId, input.clock.now(), {
            ...(reconciliationRequired ? { kind: "reconcile_required" } : {}),
            code: error.code,
            safeMessage: reconciliationRequired
              ? "External request result must be reconciled before retry"
              : "Additional user input or review is required"
          });
        } else if (error instanceof ExternalResultUnknownError) {
          if (job.remoteTaskId) {
            await input.jobs.markNeedsInput(job, input.workerId, input.clock.now(), {
              code: "reconcile_failed",
              safeMessage: "Automatic reconciliation failed; review the external task before trying again"
            });
          } else {
            await input.jobs.markResultUnknown(job, input.workerId, input.clock.now(), error.remoteTaskId, {
              code: "reconcile_required",
              safeMessage: "External request result must be reconciled before retry"
            });
          }
        } else {
          await input.jobs.fail(job, input.workerId, input.clock.now(), {
            code: "worker.handler_failed",
            safeMessage: "Worker handler failed"
          });
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => runSlot()));
  return { processed };
}
