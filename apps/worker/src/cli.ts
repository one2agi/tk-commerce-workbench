import { pathToFileURL } from "node:url";
import { rename, unlink, writeFile } from "node:fs/promises";

import type { LiveCommandContext } from "@tk/adapters";

import { createWorkerApplication, type WorkerApplication } from "./entry.js";
import { log } from "./log.js";

export interface RunWorkerProcessInput {
  application?: WorkerApplication;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxJobsPerCycle?: number;
  maxCycles?: number;
}

async function writeReadyProof(env: NodeJS.ProcessEnv): Promise<void> {
  const launchId = env.TK_RUNTIME_LAUNCH_ID?.trim();
  const readyPath = env.TK_WORKER_READY_PATH?.trim();
  if (!launchId && !readyPath) return;
  if (!launchId || !readyPath) {
    throw new Error("worker process: launch id and ready path must be configured together");
  }
  const temporaryPath = `${readyPath}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ launchId, pid: process.pid })}\n`,
      { flag: "wx", mode: 0o600 }
    );
    await rename(temporaryPath, readyPath);
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
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
  let readinessWritten = false;
  try {
    while (!input.signal?.aborted && cycles < maxCycles) {
      const result = await application.run({ maxJobs: maxJobsPerCycle });
      if (!readinessWritten) {
        await writeReadyProof(env);
        readinessWritten = true;
      }
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
  // Catch-net for any DB-termination or adapter error that escapes the
  // runWorkerProcess loop. The handler logs a single static line — never the
  // Error object itself, which would dump the connection string and adapter
  // config into the runtime's stderr (and trip the sensitive-log fuse on
  // startup). Application-level close() runs in the finally block of
  // runWorkerProcess; here we just exit non-zero so the runtime manager
  // observes a clean process exit and runs its own stopBoth on the group.
  const onUnhandled = (kind: "rejection" | "exception") => {
    log.error("worker: unhandled error", { kind });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };
  process.on("unhandledRejection", () => onUnhandled("rejection"));
  process.on("uncaughtException", () => onUnhandled("exception"));

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorkerProcess({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("uncaughtException", onUnhandled);
  }
}

const executable = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === executable) {
  void main().catch(() => {
    // Keep startup errors secret-safe: detailed configuration values and adapter
    // payloads are deliberately not written to stdout/stderr.
    log.error("worker process stopped during startup or polling");
    process.exitCode = 1;
  });
}
