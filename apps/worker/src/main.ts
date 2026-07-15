import { runWorkerLoop, type WorkerHandler, type WorkerJobRepository } from "./runtime/worker-loop.js";

export async function runWorker(input: {
  jobs: WorkerJobRepository;
  handlers: Readonly<Record<string, WorkerHandler>>;
  workerId: string;
  leaseMs: number;
  clock?: { now(): Date };
  maxJobs?: number;
}) {
  return runWorkerLoop({
    ...input,
    clock: input.clock ?? { now: () => new Date() }
  });
}
