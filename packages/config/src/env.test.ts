import { describe, expect, it } from "vitest";
import { getSecretStatus, loadConfig, resolveRuntimeAppConfig } from "./env.js";
import type {
  PublicServiceConfigurationV1,
  RuntimeSecretsV1
} from "../../contracts/src/runtime-configuration.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
  TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
  LOCAL_OPERATOR_ID: "operator_local_01",
  EXTENSION_TOKEN: "test-token-do-not-log",
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  ALLOW_LAN: "false",
  EXTERNAL_ADAPTER_MODE: "mock",
  ASSET_ROOT: "./data/assets",
  WORKER_CONCURRENCY: "2",
  WORKER_LEASE_MS: "60000",
  MAX_CANVAS_RUNS_PER_DAY: "50",
  NODE_ENV: "test"
};

describe("config env", () => {
  it("parses loopback-friendly base configuration", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.localOperatorId).toBe("operator_local_01");
    expect(cfg.allowLan).toBe(false);
    expect(cfg.externalAdapterMode).toBe("mock");
    expect(cfg.configEncryptionKey).toBe(BASE_ENV.CONFIG_ENCRYPTION_KEY);
  });

  it("accepts the explicit local PGlite test database sentinel", () => {
    expect(loadConfig({ ...BASE_ENV, TEST_DATABASE_URL: "pglite://_test" }).testDatabaseUrl)
      .toBe("pglite://_test");
  });

  it("refuses to boot test/integration/e2e in live external adapter mode", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, EXTERNAL_ADAPTER_MODE: "live", NODE_ENV: "test" })
    ).toThrow(/external adapter mode=live/i);
  });

  it("returns booleans only from getSecretStatus", () => {
    const cfg = loadConfig(BASE_ENV);
    const status = getSecretStatus(cfg);
    expect(status.miaoshouConfigured).toBe(false);
    expect(status.canvasConfigured).toBe(false);
    expect(status.llmConfigured).toBe(false);
    expect(status).not.toHaveProperty("miaoshouAppKey");
    expect(status).not.toHaveProperty("miaoshouAppSecret");
  });

  it("keeps server-only live adapter settings in AppConfig but never in the safe status view", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CANVAS_BASE_URL: "https://canvas.test/",
      CANVAS_ID: "canvas-local-1",
      CANVAS_WORKFLOW_NAME: "TK工作流",
      CANVAS_API_KEY: "TEST_CANVAS_SECRET_DO_NOT_LOG",
      LLM_BASE_URL: "https://llm.test/v1/",
      LLM_API_KEY: "TEST_LLM_SECRET_DO_NOT_LOG",
      LLM_MODEL: "model-1",
      EXCHANGE_RATE_BASE_URL: "https://rates.test/"
    });
    expect(cfg.canvasBaseUrl).toBe("https://canvas.test/");
    expect(cfg.canvasId).toBe("canvas-local-1");
    expect(cfg.canvasWorkflowName).toBe("TK工作流");
    expect(cfg.llmModel).toBe("model-1");
    expect(cfg.canvasApiKey).toBe("TEST_CANVAS_SECRET_DO_NOT_LOG");
    const safe = JSON.stringify(getSecretStatus(cfg));
    expect(safe).not.toMatch(/TEST_(?:CANVAS|LLM)_SECRET_DO_NOT_LOG/);
    expect(JSON.parse(safe)).toEqual({
      miaoshouConfigured: false,
      canvasConfigured: true,
      llmConfigured: true,
      exchangeRateConfigured: true,
      imageGenerationConfigured: false,
      imageGenerationPath: "canvas",
      assetPublishingConfigured: false
    });
  });

  it("treats Canvas base URL as configured when the Canvas deployment does not require an API key", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CANVAS_BASE_URL: "https://canvas.test/"
    });
    expect(cfg.canvasId).toBe("0f91cb2d8f2846c091829af30ea2d18d");
    expect(cfg.canvasWorkflowName).toBe("TK工作流");
    expect(cfg.canvasApiKey).toBe("");
    expect(getSecretStatus(cfg).canvasConfigured).toBe(true);
  });

  it("loads non-secret image runtime choices and reports headless readiness without exposing credentials", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      IMAGE_GENERATION_PATH: "headless",
      IMAGE_PLANNER_BASE_URL: "https://planner.test/v1",
      IMAGE_PLANNER_API_KEY: "TEST_PLANNER_SECRET_DO_NOT_LOG",
      IMAGE_PLANNER_MODEL: "planner-v4",
      IMAGE_PROVIDER_BASE_URL: "https://images.test/v1",
      IMAGE_PROVIDER_API_KEY: "TEST_IMAGE_SECRET_DO_NOT_LOG",
      IMAGE_PROVIDER_MODEL: "image-v2"
    });

    expect(cfg.imageGenerationPath).toBe("headless");
    expect(cfg.imagePlannerModel).toBe("planner-v4");
    expect(cfg.imageProviderModel).toBe("image-v2");
    expect(cfg.imageGenerationConfigured).toBe(true);
    const safe = JSON.stringify(getSecretStatus(cfg));
    expect(safe).not.toMatch(/TEST_(?:PLANNER|IMAGE)_SECRET_DO_NOT_LOG/);
    expect(JSON.parse(safe)).toMatchObject({ imageGenerationConfigured: true });
  });

  it("accepts zero Canvas runs as the documented unlimited value", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_CANVAS_RUNS_PER_DAY: "0" }).maxCanvasRunsPerDay).toBe(0);
  });

  it("reports image generation configured only when both planner and image provider are complete", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      IMAGE_PLANNER_BASE_URL: "https://planner.test",
      IMAGE_PLANNER_API_KEY: "planner-key",
      IMAGE_PLANNER_MODEL: "gpt-4o",
      IMAGE_PROVIDER_BASE_URL: "https://images.test",
      IMAGE_PROVIDER_API_KEY: "provider-key",
      IMAGE_PROVIDER_MODEL: "dall-e-3"
    });
    expect(cfg.imageGenerationConfigured).toBe(true);
  });

  it("reports asset publishing configured only when all S3 fields are present", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      ASSET_PUBLISH_S3_ENDPOINT: "https://s3.example.com",
      ASSET_PUBLISH_S3_REGION: "us-east-1",
      ASSET_PUBLISH_S3_BUCKET: "tk-assets",
      ASSET_PUBLISH_S3_ACCESS_KEY_ID: "test-key",
      ASSET_PUBLISH_S3_SECRET_ACCESS_KEY: "test-secret",
      ASSET_PUBLISH_PUBLIC_BASE_URL: "https://cdn.example.com"
    });
    expect(cfg.assetPublishingConfigured).toBe(true);
    expect(getSecretStatus(cfg).assetPublishingConfigured).toBe(true);
  });

  it("reports asset publishing not configured when any S3 field is missing", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      ASSET_PUBLISH_S3_ENDPOINT: "https://s3.example.com",
      ASSET_PUBLISH_S3_REGION: "us-east-1",
      ASSET_PUBLISH_S3_BUCKET: "tk-assets",
      ASSET_PUBLISH_S3_ACCESS_KEY_ID: "test-key",
      ASSET_PUBLISH_S3_SECRET_ACCESS_KEY: "",
      ASSET_PUBLISH_PUBLIC_BASE_URL: "https://cdn.example.com"
    });
    expect(cfg.assetPublishingConfigured).toBe(false);
  });

  it("defaults IMAGE_GENERATION_PATH to canvas when not set", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.imageGenerationPath).toBe("canvas");
    expect(getSecretStatus(cfg).imageGenerationPath).toBe("canvas");
  });

  it("accepts explicit headless and canvas routing", () => {
    expect(loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "headless" }).imageGenerationPath).toBe("headless");
    expect(loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "canvas" }).imageGenerationPath).toBe("canvas");
  });

  it("parses IMAGE_GENERATION_PATH as headless when explicitly set", () => {
    const cfg = loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "headless" });
    expect(cfg.imageGenerationPath).toBe("headless");
    expect(getSecretStatus(cfg).imageGenerationPath).toBe("headless");
  });

  it("rejects unknown IMAGE_GENERATION_PATH values", () => {
    expect(() => loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "unknown" }))
      .toThrow(/IMAGE_GENERATION_PATH/);
  });

  it("allows legacy provider secrets to be absent after database seeding", () => {
    const { EXTENSION_TOKEN: _extensionToken, ...deploymentEnv } = BASE_ENV;
    expect(loadConfig(deploymentEnv).extensionToken).toBe("");
  });

  it("resolves stored service values into AppConfig and recomputes configured flags", () => {
    const bootstrap = loadConfig(BASE_ENV);
    const publicConfig: PublicServiceConfigurationV1 = {
      imageGenerationPath: "headless",
      imagePlannerBaseUrl: "https://planner.saved/v1",
      imagePlannerModel: "planner-saved",
      imageProviderBaseUrl: "https://images.saved/v1",
      imageProviderModel: "image-saved",
      canvasBaseUrl: "",
      canvasId: "canvas-saved",
      canvasWorkflowName: "workflow-saved",
      llmBaseUrl: "https://llm.saved/v1",
      llmModel: "llm-saved",
      exchangeRateBaseUrl: "https://rates.saved",
      miaoshouBaseUrl: "https://miaoshou.saved",
      miaoshouAccountId: "account-saved",
      assetPublishS3Endpoint: "https://s3.saved",
      assetPublishS3Region: "saved-region",
      assetPublishS3Bucket: "saved-bucket",
      assetPublishPublicBaseUrl: "https://cdn.saved"
    };
    const secrets: RuntimeSecretsV1 = {
      imagePlannerApiKey: "planner-secret",
      imageProviderApiKey: "provider-secret",
      llmApiKey: "llm-secret",
      miaoshouAppKey: "miaoshou-key",
      miaoshouAppSecret: "miaoshou-secret",
      miaoshouAuthorization: "authorization-secret",
      miaoshouCookie: "cookie-secret",
      assetPublishS3AccessKeyId: "s3-key",
      assetPublishS3SecretAccessKey: "s3-secret",
      extensionToken: "extension-secret"
    };

    const resolved = resolveRuntimeAppConfig(bootstrap, publicConfig, secrets);

    expect(resolved).toMatchObject({
      databaseUrl: bootstrap.databaseUrl,
      testDatabaseUrl: bootstrap.testDatabaseUrl,
      assetRoot: bootstrap.assetRoot,
      localOperatorId: bootstrap.localOperatorId,
      workerLeaseMs: bootstrap.workerLeaseMs,
      nodeEnv: bootstrap.nodeEnv,
      configEncryptionKey: bootstrap.configEncryptionKey,
      imageGenerationPath: "headless",
      imagePlannerBaseUrl: "https://planner.saved/v1",
      imagePlannerApiKey: "planner-secret",
      imageProviderApiKey: "provider-secret",
      canvasBaseUrl: "",
      canvasApiKey: "",
      llmApiKey: "llm-secret",
      miaoshouBaseUrl: "https://miaoshou.saved",
      miaoshouAppKey: "miaoshou-key",
      miaoshouAppSecret: "miaoshou-secret",
      miaoshouAuthorization: "authorization-secret",
      miaoshouCookie: "cookie-secret",
      extensionToken: "extension-secret",
      miaoshouConfigured: true,
      canvasConfigured: false,
      llmConfigured: true,
      exchangeRateConfigured: true,
      imageGenerationConfigured: true,
      assetPublishingConfigured: true
    });
  });
});
