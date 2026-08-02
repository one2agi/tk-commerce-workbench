import { describe, expect, it } from "vitest";
import { getSecretStatus, loadConfig } from "./env.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
  TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
  LOCAL_OPERATOR_ID: "operator_local_01",
  EXTENSION_TOKEN: "test-token-do-not-log",
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
    expect(JSON.parse(safe)).toEqual({ miaoshouConfigured: false, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true, imageGenerationConfigured: false, imageGenerationPath: "headless", assetPublishingConfigured: false });
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

  it("defaults IMAGE_GENERATION_PATH to headless when not set", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.imageGenerationPath).toBe("headless");
    expect(getSecretStatus(cfg).imageGenerationPath).toBe("headless");
  });

  it("defaults new work to headless and preserves explicit canvas for legacy tasks", () => {
    expect(loadConfig(BASE_ENV).imageGenerationPath).toBe("headless");
    expect(loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "canvas" }).imageGenerationPath).toBe("canvas");
  });

  it("parses IMAGE_GENERATION_PATH as headless when explicitly set", () => {
    const cfg = loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "headless" });
    expect(cfg.imageGenerationPath).toBe("headless");
    expect(getSecretStatus(cfg).imageGenerationPath).toBe("headless");
  });

  it("treats unknown IMAGE_GENERATION_PATH values as canvas (compatibility default)", () => {
    const cfg = loadConfig({ ...BASE_ENV, IMAGE_GENERATION_PATH: "unknown" });
    expect(cfg.imageGenerationPath).toBe("canvas");
  });
});
