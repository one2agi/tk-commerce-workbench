import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";

import { log } from "./log.js";

import {
  MIAOSHOU_DEFAULT_BASE_URL,
  createMiaoshouEditAdapter,
  createMiaoshouHttp,
  createSafeUrlReachability,
  createEnvAwareFetch,
  fingerprintApprovalSnapshot,
  stableDigest,
  createAdapterBundle as createDefaultAdapterBundle,
  createLiveMiaoshouSourceAdapter,
  type AdapterBundle,
  type AdapterFactoryConfig,
  type LiveCommandContext,
  type MiaoshouConfig,
  type MiaoshouEditExpectationResolver
} from "@tk/adapters";
import { loadConfig } from "@tk/config";
import { createFakePorts } from "@tk/contracts/testing";
import type { MiaoshouEditPort, MiaoshouSourcePort } from "@tk/contracts";
import {
  AuditRepository,
  ApprovalRepository,
  CanvasQuotaRepository,
  ContentAddressedStore,
  JobRepository,
  PipelineRepository,
  createNodePinnedAssetFetch,
  pipelineRepositories,
  type AssetFetch,
  type AssetFetchResponse,
  type DbPool
} from "@tk/db";
import type { ImageSignals } from "@tk/domain/assets/score-image";
import pg from "pg";

import { buildWorkerRuntime } from "./main.js";
import { adaptLeasedJobRepository } from "./runtime/worker-loop.js";
import { createStagingCleanupCodec } from "./runtime/staging-cleanup-codec.js";

type EnvAwareFetch = ReturnType<typeof createEnvAwareFetch>;

export type WorkerProcessKind = "app" | "test" | "integration" | "e2e";
export const LIVE_MIAOSHOU_MIN_INTERVAL_MS = 250;

export interface ClosableDbPool extends DbPool {
  end(): Promise<void>;
}

export interface WorkerEntryDependencies {
  createPool?: (connectionString: string) => ClosableDbPool;
  createAdapterBundle?: (config: AdapterFactoryConfig, context?: LiveCommandContext) => AdapterBundle;
  createLiveFetch?: (env: NodeJS.ProcessEnv) => EnvAwareFetch;
  createMiaoshou?: (config: MiaoshouConfig, fetchImpl?: typeof fetch) => MiaoshouSourcePort;
  createMiaoshouEdit?: (config: MiaoshouConfig, resolver: MiaoshouEditExpectationResolver, fetchImpl?: typeof fetch) => MiaoshouEditPort;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface CreateWorkerApplicationInput {
  env?: NodeJS.ProcessEnv;
  processKind?: WorkerProcessKind;
  commandContext?: LiveCommandContext;
  miaoshou?: MiaoshouSourcePort;
  miaoshouEdit?: MiaoshouEditPort;
  dependencies?: WorkerEntryDependencies;
}

export interface WorkerApplication {
  run(input?: { workerId?: string; maxJobs?: number }): Promise<{ processed: number }>;
  counters(): ReturnType<AdapterBundle["counters"]>;
  close(): Promise<void>;
}

export function createCanvasOutputAssetFetch(input: {
  baseUrl: string;
  liveFetch: typeof fetch;
  fallbackFetch: AssetFetch;
  maxBytes?: number;
}): AssetFetch {
  const baseOrigin = new URL(`${input.baseUrl.replace(/\/+$/, "")}/`).origin;
  const maxBytes = input.maxBytes ?? 20 * 1024 * 1024;
  return async (request): Promise<AssetFetchResponse> => {
    const url = new URL(request.url);
    if (url.origin !== baseOrigin || !url.pathname.startsWith("/assets/output/")) {
      return input.fallbackFetch(request);
    }

    const response = await input.liveFetch(url.toString(), {
      headers: { accept: "image/png,image/jpeg" }
    });
    const headers: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const declaredLength = Number(headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error("canvas output response size exceeds limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("canvas output response size exceeds limit");
    return {
      status: response.status,
      headers,
      body: (async function* () { yield bytes; })()
    };
  };
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

async function closeWorkerResources(
  pool: ClosableDbPool | undefined,
  liveFetch: EnvAwareFetch | undefined
): Promise<void> {
  const operations: Array<Promise<unknown>> = [];
  if (pool) operations.push(Promise.resolve().then(() => pool.end()));
  if (liveFetch) operations.push(Promise.resolve().then(() => liveFetch.close()));
  const results = await Promise.allSettled(operations);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "worker resource cleanup failed");
}

export function createWorkerApplication(input: CreateWorkerApplicationInput = {}): WorkerApplication {
  const env = input.env ?? process.env;
  const processKind = input.processKind ?? "app";
  const dependencies = input.dependencies ?? {};

  // Keep this order deliberate: config and adapter-mode guards execute before
  // a database socket, Miaoshou client, or asset HTTP transport is constructed.
  const config = loadConfig(env);
  let liveFetch: EnvAwareFetch | undefined;
  const getLiveFetch = (): EnvAwareFetch => {
    liveFetch ??= (dependencies.createLiveFetch ?? createEnvAwareFetch)(env);
    return liveFetch;
  };
  const adapters = dependencies.createAdapterBundle
    ? dependencies.createAdapterBundle({ ...config, processKind }, input.commandContext)
    : createDefaultAdapterBundle(
      { ...config, processKind },
      input.commandContext,
      { createLiveFetch: getLiveFetch }
    );

  let acquiredPool: ClosableDbPool | undefined;
  try {
    const connectionString = processKind === "test" || processKind === "integration" || processKind === "e2e"
      ? config.testDatabaseUrl
      : config.databaseUrl;
    const pool = (dependencies.createPool ?? ((url) => new pg.Pool({ connectionString: url })))(connectionString);
    acquiredPool = pool;
    // pg.Pool emits "error" for idle-client disconnects and pool-level issues
    // (notably: postgres server termination while a client is checked out).
    // Without a listener Node treats this as an uncaughtException and may
    // dump the offending Error — which contains the connection string — to
    // stderr. The runtime's secret-fuse would then trip on the URL prefix in
    // the log. Log a single static line so the message is grep-friendly and
    // never embeds the connection string, the password, or any env value.
    pool.on("error", () => {
      log.error("database pool error");
    });

  let miaoshou = input.miaoshou;
  if (!miaoshou) {
    if (adapters.mode === "mock") miaoshou = createFakePorts().miaoshouSource;
    else miaoshou = (dependencies.createMiaoshou ?? createLiveMiaoshouSourceAdapter)(miaoshouConfig(env), getLiveFetch());
  }

  const resolveHost = dependencies.resolveHost ?? (async (hostname: string) =>
    (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const fallbackAssetFetch = createNodePinnedAssetFetch();
  const store = new ContentAddressedStore({
    assetRoot: config.assetRoot,
    fetch: adapters.mode === "live"
      ? createCanvasOutputAssetFetch({
        baseUrl: config.canvasBaseUrl,
        liveFetch: getLiveFetch(),
        fallbackFetch: fallbackAssetFetch
      })
      : fallbackAssetFetch,
    resolveHost
  });
  const pipeline = new PipelineRepository(pool, config.localOperatorId);
  const jobs = new JobRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const expectationResolver: MiaoshouEditExpectationResolver = {
    resolve: async ({ canonicalSuccessDetailId, sourceItemId }) => {
      const context = await jobs.loadMiaoshouReconciliationContext(canonicalSuccessDetailId, sourceItemId);
      if (!context) return undefined;
      const snapshot = await approvals.loadSnapshot(context.approvalSnapshotId).catch(() => undefined);
      if (!snapshot || stableDigest(snapshot) !== context.approvalSnapshotDigest) return undefined;
      const expected = fingerprintApprovalSnapshot(snapshot, context.orderedRemoteAssetUrlSha256);
      return stableDigest(expected) === stableDigest(context.expectedDetail) ? expected : undefined;
    }
  };
  let miaoshouEdit = input.miaoshouEdit;
  if (!miaoshouEdit) {
    miaoshouEdit = adapters.mode === "mock"
      ? createFakePorts().miaoshouEdit
      : (dependencies.createMiaoshouEdit ?? ((liveConfig, resolver, fetchImpl) => createMiaoshouEditAdapter({
        http: createMiaoshouHttp(liveConfig, fetchImpl), expectationResolver: resolver
      })))(miaoshouConfig(env), expectationResolver, getLiveFetch());
  }
  const assertStagedUrlReachable = createSafeUrlReachability({
    resolveHost: async (hostname) => (await resolveHost(hostname)).map((address) => ({
      address,
      family: address.includes(":") ? 6 as const : 4 as const
    })),
    transport: async (url, _pinned, method) => {
      const response = await getLiveFetch()(url, {
        method: method === "HEAD" ? "HEAD" : "GET",
        headers: method === "RANGE" ? { range: "bytes=0-0" } : undefined
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const body = method === "HEAD" ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
      return { status: response.status, headers, bytesRead: body.byteLength };
    }
  });
  const miaoshouEditRepository = {
    loadSnapshot: (id: string) => approvals.loadSnapshot(id),
    saveSucceeded: (...args: Parameters<ApprovalRepository["saveSucceeded"]>) => approvals.saveSucceeded(...args),
    saveValidationFailure: (...args: Parameters<ApprovalRepository["saveValidationFailure"]>) => approvals.saveValidationFailure(...args),
    saveResultUnknown: (...args: Parameters<ApprovalRepository["saveResultUnknown"]>) => approvals.saveResultUnknown(...args),
    saveReconciliationResultUnknown: (...args: Parameters<ApprovalRepository["saveReconciliationResultUnknown"]>) => approvals.saveReconciliationResultUnknown(...args),
    saveReconciled: (...args: Parameters<ApprovalRepository["saveReconciled"]>) => approvals.saveReconciled(...args),
    persistReconciliationContext: (context: Parameters<JobRepository["persistMiaoshouReconciliationContext"]>[4], fence: { jobId: string; owner: string; leaseToken: string }) =>
      jobs.persistMiaoshouReconciliationContext(fence.jobId, fence.owner, fence.leaseToken, new Date(), context)
  };
  const runtime = buildWorkerRuntime({
    ports: {
      miaoshou,
      miaoshouEdit,
      llm: adapters.llm,
      exchangeRate: adapters.exchangeRate,
      canvas: adapters.canvas,
      staging: adapters.assetStaging,
      publishing: adapters.assetPublishing,
      imagePlanner: adapters.imagePlanner,
      imageGeneration: adapters.imageGeneration
    },
    repositories: {
      ...pipelineRepositories(pipeline),
      prepareMiaoshouWriteback: {
        bindCanonicalAndEnqueueEdit: (
          ...args: Parameters<ApprovalRepository["bindCanonicalAndEnqueueEdit"]>
        ) => approvals.bindCanonicalAndEnqueueEdit(...args)
      },
      miaoshouEdit: miaoshouEditRepository
    },
    reachability: { assertReachable: async (urls) => { await Promise.all(urls.map(assertStagedUrlReachable)); } },
    cleanupCodec: createStagingCleanupCodec(config.extensionToken),
    store,
    analyzer: createLocalImageAnalyzer(),
    quota: new CanvasQuotaRepository(pool),
    audit: auditPort(new AuditRepository(pool)),
    now: () => new Date(),
    maxCanvasRunsPerDay: config.maxCanvasRunsPerDay,
    adapterLimits: {
      miaoshou: { concurrency: 1, minIntervalMs: LIVE_MIAOSHOU_MIN_INTERVAL_MS },
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
      close: () => closeWorkerResources(pool, liveFetch)
    };
  } catch (error) {
    void closeWorkerResources(acquiredPool, liveFetch).catch(() => undefined);
    throw error;
  }
}
