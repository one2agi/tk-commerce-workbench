import { pathToFileURL } from "node:url";

import type { LiveCommandContext } from "@tk/adapters";

import { createWorkerApplication, type WorkerApplication } from "./entry.js";

export interface RunWorkerProcessInput {
  application?: WorkerApplication;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxJobsPerCycle?: number;
  maxCycles?: number;
}

function liveCommandContext(env: NodeJS.ProcessEnv): LiveCommandContext | undefined {
  const commandId = env.WORKER_COMMAND_ID?.trim();
  const idempotencyKey = env.WORKER_IDEMPOTENCY_KEY?.trim();
  if (!commandId && !idempotencyKey) return undefined;
  if (!commandId || !idempotencyKey) {
    throw new Error("worker process: both WORKER_COMMAND_ID and WORKER_IDEMPOTENCY_KEY are required");
  }
  return { kind: "worker_command", commandId, idempotencyKey };
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runWorkerProcess(input: RunWorkerProcessInput = {}): Promise<void> {
  const env = input.env ?? process.env;
  const application = input.application ?? createWorkerApplication({
    env,
    processKind: "app",
    commandContext: liveCommandContext(env)
  });
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const maxJobsPerCycle = input.maxJobsPerCycle ?? 100;
  const maxCycles = input.maxCycles ?? Number.POSITIVE_INFINITY;
  let cycles = 0;
  try {
    while (!input.signal?.aborted && cycles < maxCycles) {
      const result = await application.run({ maxJobs: maxJobsPerCycle });
      cycles += 1;
      if (cycles < maxCycles && !input.signal?.aborted && result.processed === 0) {
        await waitForNextPoll(pollIntervalMs, input.signal);
      }
    }
  } finally {
    await application.close();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorkerProcess({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const executable = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === executable) {
  void main().catch(() => {
    // Keep startup errors secret-safe: detailed configuration values and adapter
    // payloads are deliberately not written to stdout/stderr.
    console.error("worker process stopped during startup or polling");
    process.exitCode = 1;
  });
}
