// Server-only configuration loader. AppConfig may contain adapter credentials and must never
// be serialized or logged. `getSecretStatus()` is the only safe view and returns booleans.
// In test / integration / e2e, `EXTERNAL_ADAPTER_MODE=live` aborts startup.

export type ExternalAdapterMode = "mock" | "live";

export interface SecretStatus {
  readonly miaoshouConfigured: boolean;
  readonly canvasConfigured: boolean;
  readonly llmConfigured: boolean;
  readonly exchangeRateConfigured: boolean;
  readonly imageGenerationConfigured: boolean;
  readonly imageGenerationPath: ImageGenerationPath;
  readonly assetPublishingConfigured: boolean;
}

export type ImageGenerationPath = "headless" | "canvas";

export interface AppConfig {
  readonly databaseUrl: string;
  readonly testDatabaseUrl: string;
  readonly localOperatorId: string;
  readonly extensionToken: string;
  readonly allowLan: boolean;
  readonly externalAdapterMode: ExternalAdapterMode;
  readonly assetRoot: string;
  readonly workerConcurrency: number;
  readonly workerLeaseMs: number;
  readonly maxCanvasRunsPerDay: number;
  readonly nodeEnv: "test" | "development" | "production";
  readonly configEncryptionKey: string;
  readonly miaoshouConfigured: boolean;
  readonly canvasConfigured: boolean;
  readonly llmConfigured: boolean;
  readonly exchangeRateConfigured: boolean;
  readonly imageGenerationConfigured: boolean;
  readonly imageGenerationPath: ImageGenerationPath;
  readonly assetPublishingConfigured: boolean;
  readonly canvasBaseUrl: string;
  readonly canvasId: string;
  readonly canvasWorkflowName: string;
  readonly canvasApiKey: string;
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly llmModel: string;
  readonly exchangeRateBaseUrl: string;
  readonly imagePlannerBaseUrl: string;
  readonly imagePlannerApiKey: string;
  readonly imagePlannerModel: string;
  readonly imageProviderBaseUrl: string;
  readonly imageProviderApiKey: string;
  readonly imageProviderModel: string;
  readonly assetPublishS3Endpoint: string;
  readonly assetPublishS3Region: string;
  readonly assetPublishS3Bucket: string;
  readonly assetPublishS3AccessKeyId: string;
  readonly assetPublishS3SecretAccessKey: string;
  readonly assetPublishPublicBaseUrl: string;
}

const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;
const PGLITE_TEST_URL = "pglite://_test";

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  return raw.trim();
}

function require_(env: NodeJS.ProcessEnv, key: string): string {
  const v = read(env, key);
  if (v === undefined || v.length === 0) {
    throw new Error(`config: required env var ${key} is missing or empty`);
  }
  return v;
}

function ensureLoopbackUnlessAllowLan(env: NodeJS.ProcessEnv): void {
  const allowLan = (read(env, "ALLOW_LAN") ?? "false").toLowerCase() === "true";
  if (allowLan) return;

  const urls = [read(env, "DATABASE_URL"), read(env, "TEST_DATABASE_URL")];
  for (const url of urls) {
    if (!url) continue;
    if (url === PGLITE_TEST_URL) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`config: invalid URL value for ${url}`);
    }
    if (!LOOPBACK_HOST_PATTERN.test(host)) {
      throw new Error(
        `config: refusing to point at non-loopback host '${host}' while ALLOW_LAN=false`
      );
    }
  }
}

function parseIntStrict(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`config: ${key} must be an integer; received '${raw}'`);
  }
  return Number.parseInt(raw, 10);
}

function parseExternalAdapterMode(env: NodeJS.ProcessEnv, nodeEnv: AppConfig["nodeEnv"]): ExternalAdapterMode {
  const raw = (read(env, "EXTERNAL_ADAPTER_MODE") ?? "mock").toLowerCase();
  if (raw !== "mock" && raw !== "live") {
    throw new Error(`config: EXTERNAL_ADAPTER_MODE must be 'mock' or 'live'`);
  }
  if (raw === "live" && nodeEnv === "test") {
    throw new Error(
      "config: refusing to boot test/integration/e2e process with external adapter mode=live"
    );
  }
  return raw;
}

function parseNodeEnv(env: NodeJS.ProcessEnv): AppConfig["nodeEnv"] {
  const raw = (read(env, "NODE_ENV") ?? "development").toLowerCase();
  if (raw === "test" || raw === "production") return raw;
  return "development";
}

function parseImageGenerationPath(env: NodeJS.ProcessEnv): ImageGenerationPath {
  const raw = (read(env, "IMAGE_GENERATION_PATH") ?? "canvas").toLowerCase();
  if (raw !== "headless" && raw !== "canvas") {
    throw new Error("config: IMAGE_GENERATION_PATH must be 'headless' or 'canvas'");
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env);

  const databaseUrl = require_(env, "DATABASE_URL");
  const testDatabaseUrl = require_(env, "TEST_DATABASE_URL");
  if (testDatabaseUrl !== PGLITE_TEST_URL && !/_test$/i.test(new URL(testDatabaseUrl).pathname.replace(/^\//, ""))) {
    throw new Error("config: TEST_DATABASE_URL must point at a database whose name ends with _test");
  }

  ensureLoopbackUnlessAllowLan(env);

  const allowLan = (read(env, "ALLOW_LAN") ?? "false").toLowerCase() === "true";
  const externalAdapterMode = parseExternalAdapterMode(env, nodeEnv);
  const imageGenerationPath = parseImageGenerationPath(env);
  const imagePlannerBaseUrl = read(env, "IMAGE_PLANNER_BASE_URL") ?? "";
  const imagePlannerApiKey = read(env, "IMAGE_PLANNER_API_KEY") ?? "";
  const imagePlannerModel = read(env, "IMAGE_PLANNER_MODEL") ?? "";
  const imageProviderBaseUrl = read(env, "IMAGE_PROVIDER_BASE_URL") ?? "";
  const imageProviderApiKey = read(env, "IMAGE_PROVIDER_API_KEY") ?? "";
  const imageProviderModel = read(env, "IMAGE_PROVIDER_MODEL") ?? "";

  return {
    databaseUrl,
    testDatabaseUrl,
    localOperatorId: require_(env, "LOCAL_OPERATOR_ID"),
    extensionToken: require_(env, "EXTENSION_TOKEN"),
    allowLan,
    externalAdapterMode,
    assetRoot: read(env, "ASSET_ROOT") ?? "./data/assets",
    workerConcurrency: parseIntStrict(env, "WORKER_CONCURRENCY", 2),
    workerLeaseMs: parseIntStrict(env, "WORKER_LEASE_MS", 60_000),
    maxCanvasRunsPerDay: parseIntStrict(env, "MAX_CANVAS_RUNS_PER_DAY", 50),
    nodeEnv,
    configEncryptionKey: read(env, "CONFIG_ENCRYPTION_KEY") ?? "",
    miaoshouConfigured: Boolean(read(env, "MIAOSHOU_APP_KEY") && read(env, "MIAOSHOU_APP_SECRET")),
    canvasConfigured: Boolean(read(env, "CANVAS_BASE_URL")),
    llmConfigured: Boolean(read(env, "LLM_BASE_URL") && read(env, "LLM_API_KEY")),
    exchangeRateConfigured: Boolean(read(env, "EXCHANGE_RATE_BASE_URL")),
    imageGenerationConfigured: Boolean(
      imagePlannerBaseUrl && imagePlannerApiKey && imagePlannerModel &&
      imageProviderBaseUrl && imageProviderApiKey && imageProviderModel
    ),
    imageGenerationPath,
    assetPublishingConfigured: Boolean(
      read(env, "ASSET_PUBLISH_S3_ENDPOINT") && read(env, "ASSET_PUBLISH_S3_REGION") &&
      read(env, "ASSET_PUBLISH_S3_BUCKET") && read(env, "ASSET_PUBLISH_S3_ACCESS_KEY_ID") &&
      read(env, "ASSET_PUBLISH_S3_SECRET_ACCESS_KEY") && read(env, "ASSET_PUBLISH_PUBLIC_BASE_URL")
    ),
    canvasBaseUrl: read(env, "CANVAS_BASE_URL") ?? "",
    canvasId: read(env, "CANVAS_ID") ?? "0f91cb2d8f2846c091829af30ea2d18d",
    canvasWorkflowName: read(env, "CANVAS_WORKFLOW_NAME") ?? "TK工作流",
    canvasApiKey: read(env, "CANVAS_API_KEY") ?? "",
    llmBaseUrl: read(env, "LLM_BASE_URL") ?? "",
    llmApiKey: read(env, "LLM_API_KEY") ?? "",
    llmModel: read(env, "LLM_MODEL") ?? "",
    exchangeRateBaseUrl: read(env, "EXCHANGE_RATE_BASE_URL") ?? "",
    imagePlannerBaseUrl,
    imagePlannerApiKey,
    imagePlannerModel,
    imageProviderBaseUrl,
    imageProviderApiKey,
    imageProviderModel,
    assetPublishS3Endpoint: read(env, "ASSET_PUBLISH_S3_ENDPOINT") ?? "",
    assetPublishS3Region: read(env, "ASSET_PUBLISH_S3_REGION") ?? "",
    assetPublishS3Bucket: read(env, "ASSET_PUBLISH_S3_BUCKET") ?? "",
    assetPublishS3AccessKeyId: read(env, "ASSET_PUBLISH_S3_ACCESS_KEY_ID") ?? "",
    assetPublishS3SecretAccessKey: read(env, "ASSET_PUBLISH_S3_SECRET_ACCESS_KEY") ?? "",
    assetPublishPublicBaseUrl: read(env, "ASSET_PUBLISH_PUBLIC_BASE_URL") ?? ""
  };
}

export function getSecretStatus(cfg: AppConfig): SecretStatus {
  return Object.freeze({
    miaoshouConfigured: cfg.miaoshouConfigured,
    canvasConfigured: cfg.canvasConfigured,
    llmConfigured: cfg.llmConfigured,
    exchangeRateConfigured: cfg.exchangeRateConfigured,
    imageGenerationConfigured: cfg.imageGenerationConfigured,
    imageGenerationPath: cfg.imageGenerationPath,
    assetPublishingConfigured: cfg.assetPublishingConfigured
  });
}
