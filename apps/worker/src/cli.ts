import { pathToFileURL } from "node:url";
import { rename, unlink, writeFile } from "node:fs/promises";

import type { LiveCommandContext } from "@tk/adapters";
import {
  createRuntimeSecretCodec,
  loadConfig,
  resolveRuntimeAppConfig,
  type RuntimeSecretCodec
} from "../../../packages/config/src/index.js";
import type {
  PublicServiceConfigurationV1,
  RuntimeSecretsV1
} from "../../../packages/contracts/src/runtime-configuration.js";
import {
  RuntimeConfigurationRepository,
  type RuntimeConfigurationCandidate
} from "../../../packages/db/src/repositories/runtime-configuration-repository.js";
import pg from "pg";

import {
  createWorkerApplication,
  type ClosableDbPool,
  type WorkerApplication
} from "./entry.js";
import { log } from "./log.js";
import {
  createReloadableWorkerApplication,
  type ResolvedRuntimeCandidate
} from "./runtime/reloadable-worker-application.js";

export interface RunWorkerProcessInput {
  application?: WorkerApplication;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxJobsPerCycle?: number;
  maxCycles?: number;
}

type RuntimeConfigurationLoader = Pick<RuntimeConfigurationRepository,
  "seedIfMissing" | "loadCandidate" | "markApplied" | "markRejected"
>;

export interface RuntimeConfiguredWorkerDependencies {
  createPool?(connectionString: string): ClosableDbPool;
  createRepository?(pool: ClosableDbPool): RuntimeConfigurationLoader;
  createSecretCodec?(masterKeyBase64: string): RuntimeSecretCodec;
  build?(candidate: ResolvedRuntimeCandidate): Promise<WorkerApplication>;
}

export interface CreateRuntimeConfiguredWorkerApplicationInput {
  env?: NodeJS.ProcessEnv;
  dependencies?: RuntimeConfiguredWorkerDependencies;
}

function publicConfigurationFromBootstrap(config: ReturnType<typeof loadConfig>): PublicServiceConfigurationV1 {
  return {
    imageGenerationPath: config.imageGenerationPath,
    imagePlannerBaseUrl: config.imagePlannerBaseUrl,
    imagePlannerModel: config.imagePlannerModel,
    imageProviderBaseUrl: config.imageProviderBaseUrl,
    imageProviderModel: config.imageProviderModel,
    canvasBaseUrl: config.canvasBaseUrl,
    canvasId: config.canvasId,
    canvasWorkflowName: config.canvasWorkflowName,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    exchangeRateBaseUrl: config.exchangeRateBaseUrl,
    miaoshouBaseUrl: config.miaoshouBaseUrl,
    miaoshouAccountId: config.miaoshouAccountId,
    assetPublishS3Endpoint: config.assetPublishS3Endpoint,
    assetPublishS3Region: config.assetPublishS3Region,
    assetPublishS3Bucket: config.assetPublishS3Bucket,
    assetPublishPublicBaseUrl: config.assetPublishPublicBaseUrl
  };
}

function secretsFromBootstrap(config: ReturnType<typeof loadConfig>): RuntimeSecretsV1 {
  return Object.fromEntries(Object.entries({
    imagePlannerApiKey: config.imagePlannerApiKey,
    imageProviderApiKey: config.imageProviderApiKey,
    canvasApiKey: config.canvasApiKey,
    llmApiKey: config.llmApiKey,
    miaoshouAppKey: config.miaoshouAppKey,
    miaoshouAppSecret: config.miaoshouAppSecret,
    miaoshouAuthorization: config.miaoshouAuthorization,
    miaoshouCookie: config.miaoshouCookie,
    assetPublishS3AccessKeyId: config.assetPublishS3AccessKeyId,
    assetPublishS3SecretAccessKey: config.assetPublishS3SecretAccessKey,
    extensionToken: config.extensionToken
  }).filter(([, value]) => Boolean(value))) as RuntimeSecretsV1;
}

function resolveCandidate(
  bootstrap: ReturnType<typeof loadConfig>,
  codec: RuntimeSecretCodec,
  candidate: RuntimeConfigurationCandidate
): ResolvedRuntimeCandidate {
  let secrets: RuntimeSecretsV1;
  try {
    secrets = codec.open(candidate.encryptedSecrets, "workspace_settings:1");
  } catch {
    throw Object.assign(new Error("runtime configuration secrets could not be decrypted"), {
      candidateVersion: candidate.version,
      code: "runtime_configuration_secrets_invalid"
    });
  }
  return {
    version: candidate.version,
    config: resolveRuntimeAppConfig(bootstrap, candidate.publicConfig, secrets, candidate.runtimeConfig)
  };
}

export function createRuntimeConfiguredWorkerApplication(
  input: CreateRuntimeConfiguredWorkerApplicationInput = {}
): WorkerApplication {
  const env = input.env ?? process.env;
  const dependencies = input.dependencies ?? {};
  const bootstrap = loadConfig(env);
  const codec = (dependencies.createSecretCodec ?? createRuntimeSecretCodec)(bootstrap.configEncryptionKey);
  const pool = (dependencies.createPool ?? ((connectionString) => new pg.Pool({ connectionString })))(bootstrap.databaseUrl);
  pool.on("error", () => log.error("runtime configuration pool error"));
  const repository = (dependencies.createRepository ?? ((value) => new RuntimeConfigurationRepository(value)))(pool);
  const seed = {
    publicConfig: publicConfigurationFromBootstrap(bootstrap),
    encryptedSecrets: codec.seal(secretsFromBootstrap(bootstrap), "workspace_settings:1"),
    runtimeConfig: {
      externalAdapterMode: bootstrap.externalAdapterMode,
      workerConcurrency: bootstrap.workerConcurrency,
      maxCanvasRunsPerDay: bootstrap.maxCanvasRunsPerDay
    }
  };
  let seeded = false;
  const build = dependencies.build ?? (async (candidate: ResolvedRuntimeCandidate) => createWorkerApplication({
    env,
    resolvedConfig: candidate.config,
    processKind: "app",
    commandContext: liveCommandContext(env)
  }));

  return createReloadableWorkerApplication({
    async loadCandidate() {
      if (!seeded) {
        await repository.seedIfMissing(seed);
        seeded = true;
      }
      const candidate = await repository.loadCandidate();
      return candidate ? resolveCandidate(bootstrap, codec, candidate) : undefined;
    },
    build,
    markApplied: (version) => repository.markApplied(version),
    markRejected: (version, errorCode) => repository.markRejected(version, errorCode),
    closeLoader: () => pool.end()
  });
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
  const application = input.application ?? createRuntimeConfiguredWorkerApplication({ env });
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
