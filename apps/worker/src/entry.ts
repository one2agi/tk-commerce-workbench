import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";

import {
  MIAOSHOU_DEFAULT_BASE_URL,
  createAdapterBundle as createDefaultAdapterBundle,
  createLiveMiaoshouSourceAdapter,
  type AdapterBundle,
  type AdapterFactoryConfig,
  type LiveCommandContext,
  type MiaoshouConfig
} from "@tk/adapters";
import { loadConfig } from "@tk/config";
import { createFakePorts } from "@tk/contracts/testing";
import type { MiaoshouSourcePort } from "@tk/contracts";
import {
  AuditRepository,
  CanvasQuotaRepository,
  ContentAddressedStore,
  JobRepository,
  PipelineRepository,
  createNodePinnedAssetFetch,
  pipelineRepositories,
  type DbPool
} from "@tk/db";
import type { ImageSignals } from "@tk/domain/assets/score-image";
import pg from "pg";

import { buildWorkerRuntime } from "./main.js";
import { adaptLeasedJobRepository } from "./runtime/worker-loop.js";

export type WorkerProcessKind = "app" | "test" | "integration" | "e2e";

export interface ClosableDbPool extends DbPool {
  end(): Promise<void>;
}

export interface WorkerEntryDependencies {
  createPool?: (connectionString: string) => ClosableDbPool;
  createAdapterBundle?: (config: AdapterFactoryConfig, context?: LiveCommandContext) => AdapterBundle;
  createMiaoshou?: (config: MiaoshouConfig) => MiaoshouSourcePort;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface CreateWorkerApplicationInput {
  env?: NodeJS.ProcessEnv;
  processKind?: WorkerProcessKind;
  commandContext?: LiveCommandContext;
  miaoshou?: MiaoshouSourcePort;
  dependencies?: WorkerEntryDependencies;
}

export interface WorkerApplication {
  run(input?: { workerId?: string; maxJobs?: number }): Promise<{ processed: number }>;
  counters(): ReturnType<AdapterBundle["counters"]>;
  close(): Promise<void>;
}

function requiredSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`worker entry: ${key} is required for live Miaoshou`);
  return value;
}

function miaoshouConfig(env: NodeJS.ProcessEnv): MiaoshouConfig {
  return {
    baseUrl: env.MIAOSHOU_BASE_URL?.trim() || MIAOSHOU_DEFAULT_BASE_URL,
    appKey: requiredSecret(env, "MIAOSHOU_APP_KEY"),
    appSecret: requiredSecret(env, "MIAOSHOU_APP_SECRET"),
    ...(env.MIAOSHOU_ACCOUNT_ID?.trim() ? { accountId: env.MIAOSHOU_ACCOUNT_ID.trim() } : {}),
    ...(env.MIAOSHOU_AUTHORIZATION?.trim() ? { authorization: env.MIAOSHOU_AUTHORIZATION.trim() } : {}),
    ...(env.MIAOSHOU_COOKIE?.trim() ? { cookie: env.MIAOSHOU_COOKIE.trim() } : {})
  };
}

function imageDimensions(bytes: Buffer): { width: number; height: number } {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(png)) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

function createLocalImageAnalyzer() {
  return {
    async analyze(input: { archived: Record<string, unknown>; position: number }): Promise<ImageSignals> {
      const path = String(input.archived.path ?? "");
      if (!path) throw new Error("worker entry: archived asset path is missing");
      const bytes = await readFile(path);
      const dimensions = imageDimensions(bytes);
      const contentHash = String(input.archived.sha256 ?? createHash("sha256").update(bytes).digest("hex"));
      return {
        ...dimensions,
        perceptualHash: contentHash.slice(0, 16),
        clarity: 0.7,
        duplicateDistance: 10,
        watermarkProbability: 0,
        collageProbability: 0,
        nonProductProbability: 0,
        visualScore: 0.7,
        sourceKind: input.position === 0 ? "main" : "detail"
      };
    }
  };
}

function auditPort(repository: AuditRepository) {
  return {
    append(event: Record<string, unknown>) {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : undefined;
      return repository.append({
        actorType: "worker",
        action: String(event.action ?? "worker.event"),
        targetKind: String(event.targetKind ?? "worker_job"),
        targetId: String(event.targetId ?? "unknown"),
        ...(payload ? { payload } : {})
      });
    }
  };
}

export function createWorkerApplication(input: CreateWorkerApplicationInput = {}): WorkerApplication {
  const env = input.env ?? process.env;
  const processKind = input.processKind ?? "app";
  const dependencies = input.dependencies ?? {};

  // Keep this order deliberate: config and adapter-mode guards execute before
  // a database socket, Miaoshou client, or asset HTTP transport is constructed.
  const config = loadConfig(env);
  const bundleFactory = dependencies.createAdapterBundle ?? createDefaultAdapterBundle;
  const adapters = bundleFactory({ ...config, processKind }, input.commandContext);

  const connectionString = processKind === "test" || processKind === "integration" || processKind === "e2e"
    ? config.testDatabaseUrl
    : config.databaseUrl;
  const pool = (dependencies.createPool ?? ((url) => new pg.Pool({ connectionString: url })))(connectionString);

  let miaoshou = input.miaoshou;
  if (!miaoshou) {
    if (adapters.mode === "mock") miaoshou = createFakePorts().miaoshouSource;
    else miaoshou = (dependencies.createMiaoshou ?? createLiveMiaoshouSourceAdapter)(miaoshouConfig(env));
  }

  const resolveHost = dependencies.resolveHost ?? (async (hostname: string) =>
    (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const store = new ContentAddressedStore({
    assetRoot: config.assetRoot,
    fetch: createNodePinnedAssetFetch(),
    resolveHost
  });
  const pipeline = new PipelineRepository(pool, config.localOperatorId);
  const jobs = new JobRepository(pool);
  const runtime = buildWorkerRuntime({
    ports: {
      miaoshou,
      llm: adapters.llm,
      exchangeRate: adapters.exchangeRate,
      canvas: adapters.canvas,
      staging: adapters.assetStaging
    },
    repositories: pipelineRepositories(pipeline),
    store,
    analyzer: createLocalImageAnalyzer(),
    quota: new CanvasQuotaRepository(pool),
    audit: auditPort(new AuditRepository(pool)),
    now: () => new Date(),
    maxCanvasRunsPerDay: config.maxCanvasRunsPerDay,
    adapterLimits: {
      miaoshou: { concurrency: 1, minIntervalMs: 0 },
      llm: { concurrency: 1, minIntervalMs: 0 },
      exchangeRate: { concurrency: 1, minIntervalMs: 0 },
      canvas: { concurrency: 1, minIntervalMs: 0 },
      staging: { concurrency: 1, minIntervalMs: 0 }
    }
  });

  return {
    run: ({ workerId = `worker-${process.pid}`, maxJobs } = {}) => runtime.run({
      jobs: adaptLeasedJobRepository(jobs),
      workerId,
      leaseMs: config.workerLeaseMs,
      workerConcurrency: config.workerConcurrency,
      ...(maxJobs === undefined ? {} : { maxJobs })
    }),
    counters: () => adapters.counters(),
    close: () => pool.end()
  };
}
