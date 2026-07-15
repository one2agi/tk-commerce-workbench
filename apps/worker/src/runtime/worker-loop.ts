export interface EnqueueJob {
  kind: string;
  businessKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  batchKey?: string;
}

export interface ClaimedWorkerJob {
  jobId: string;
  kind: string;
  businessKey?: string;
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
    heartbeat: (job, owner, now, leaseMs) => repository.heartbeat(job.jobId, owner, job.leaseToken, now, leaseMs)
  };
}

export interface HandlerResult {
  next: readonly EnqueueJob[];
}

export type WorkerHandler = (job: ClaimedWorkerJob) => Promise<HandlerResult>;

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
  maxJobs?: number;
}): Promise<{ processed: number }> {
  await input.jobs.releaseExpired(input.clock.now());
  const maximum = input.maxJobs ?? Number.POSITIVE_INFINITY;
  let processed = 0;

  while (processed < maximum) {
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
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void input.jobs
        .heartbeat(job, input.workerId, input.clock.now(), input.leaseMs)
        .catch(() => false)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    try {
      const result = await handler(job);
      await input.jobs.completeAndEnqueue(job, input.workerId, input.clock.now(), result.next);
    } catch (error) {
      if (error instanceof RetryableJobError) {
        await input.jobs.retry(job, input.workerId, input.clock.now(), error.delayMs, {
          code: error.code,
          safeMessage: error.message
        });
      } else if (error instanceof NeedsInputError) {
        await input.jobs.markNeedsInput(job, input.workerId, input.clock.now(), {
          code: error.code,
          safeMessage: error.message
        });
      } else if (error instanceof ExternalResultUnknownError) {
        await input.jobs.markResultUnknown(job, input.workerId, input.clock.now(), error.remoteTaskId, {
          code: "reconcile_required",
          safeMessage: "External request result must be reconciled before retry"
        });
      } else {
        await input.jobs.fail(job, input.workerId, input.clock.now(), {
          code: "worker.handler_failed",
          safeMessage: error instanceof Error ? error.message : "Worker handler failed"
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
  return { processed };
}
