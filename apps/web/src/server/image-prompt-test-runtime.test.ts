import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../../packages/config/src/env.js";
import type { ImagePromptPlannerPort } from "@tk/contracts/ports";
import type { RuntimeConfigurationCandidate } from "../../../../packages/db/src/repositories/runtime-configuration-repository.js";

import { createImagePromptPlannerLoader } from "./image-prompt-test-runtime";

const PUBLIC_CONFIG = {
  imageGenerationPath: "headless" as const,
  imagePlannerBaseUrl: "https://planner.saved/v1",
  imagePlannerModel: "planner-from-ui",
  imageProviderBaseUrl: "https://images.saved/v1",
  imageProviderModel: "image-from-ui",
  canvasBaseUrl: "",
  canvasId: "canvas-saved",
  canvasWorkflowName: "workflow-saved",
  llmBaseUrl: "https://llm.saved/v1",
  llmModel: "llm-saved",
  exchangeRateBaseUrl: "https://rates.saved",
  miaoshouBaseUrl: "https://miaoshou.saved",
  miaoshouAccountId: "account-saved",
  assetPublishS3Endpoint: "",
  assetPublishS3Region: "",
  assetPublishS3Bucket: "",
  assetPublishPublicBaseUrl: ""
};

describe("image prompt test runtime", () => {
  it("constructs the planner from the applied UI-managed configuration", async () => {
    const planner: ImagePromptPlannerPort = { plan: vi.fn() };
    const createAdapters = vi.fn(() => ({ imagePlanner: planner }));
    const candidate: RuntimeConfigurationCandidate = {
      version: 7,
      publicConfig: PUBLIC_CONFIG,
      encryptedSecrets: { version: 1, nonce: "nonce", tag: "tag", ciphertext: "ciphertext" },
      runtimeConfig: {
        externalAdapterMode: "live",
        workerConcurrency: 4,
        maxCanvasRunsPerDay: 80,
        retryPolicy: { maxAttempts: 5, initialDelaySeconds: 60 }
      }
    };
    const loader = createImagePromptPlannerLoader({
      bootstrapConfig: loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        EXTERNAL_ADAPTER_MODE: "mock",
        ASSET_ROOT: "/tmp/assets",
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
      }),
      loadAppliedCandidate: async () => candidate,
      openSecrets: () => ({
        imagePlannerApiKey: "planner-secret",
        imageProviderApiKey: "provider-secret",
        llmApiKey: "llm-secret"
      }),
      createAdapters
    });

    const context = { kind: "worker_command" as const, commandId: "prompt-test:tmpl_1:v1", idempotencyKey: "prompt-test:idem_1" };
    await expect(loader(context)).resolves.toBe(planner);
    expect(createAdapters).toHaveBeenCalledWith(expect.objectContaining({
      externalAdapterMode: "live",
      imageGenerationPath: "headless",
      imagePlannerBaseUrl: "https://planner.saved/v1",
      imagePlannerModel: "planner-from-ui",
      imagePlannerApiKey: "planner-secret",
      processKind: "app"
    }), context);
  });

  it("does not fall back when applied secrets cannot be opened", async () => {
    const loader = createImagePromptPlannerLoader({
      bootstrapConfig: loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        EXTERNAL_ADAPTER_MODE: "mock",
        ASSET_ROOT: "/tmp/assets"
      }),
      loadAppliedCandidate: async () => ({
        version: 8,
        publicConfig: PUBLIC_CONFIG,
        encryptedSecrets: { version: 1, nonce: "nonce", tag: "tag", ciphertext: "broken" },
        runtimeConfig: {
          externalAdapterMode: "live",
          workerConcurrency: 4,
          maxCanvasRunsPerDay: 80,
          retryPolicy: { maxAttempts: 5, initialDelaySeconds: 60 }
        }
      }),
      openSecrets: () => { throw new Error("cannot decrypt"); },
      createAdapters: vi.fn()
    });

    await expect(loader({ kind: "worker_command", commandId: "prompt-test:tmpl_1:v1", idempotencyKey: "prompt-test:idem_2" }))
      .rejects.toThrow("runtime_configuration_unavailable");
  });

  it("does not fall back to bootstrap configuration when no UI configuration is applied", async () => {
    const createAdapters = vi.fn();
    const loader = createImagePromptPlannerLoader({
      bootstrapConfig: loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        EXTERNAL_ADAPTER_MODE: "mock",
        ASSET_ROOT: "/tmp/assets"
      }),
      loadAppliedCandidate: async () => undefined,
      createAdapters
    });

    await expect(loader({ kind: "worker_command", commandId: "prompt-test:tmpl_1:v1", idempotencyKey: "prompt-test:idem_3" }))
      .rejects.toThrow("runtime_configuration_unavailable");
    expect(createAdapters).not.toHaveBeenCalled();
  });

  it("rejects an applied mock runtime before constructing adapters", async () => {
    const createAdapters = vi.fn();
    const loader = createImagePromptPlannerLoader({
      bootstrapConfig: loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        EXTERNAL_ADAPTER_MODE: "mock",
        ASSET_ROOT: "/tmp/assets"
      }),
      loadAppliedCandidate: async () => ({
        version: 9,
        publicConfig: PUBLIC_CONFIG,
        encryptedSecrets: { version: 1, nonce: "nonce", tag: "tag", ciphertext: "ciphertext" },
        runtimeConfig: {
          externalAdapterMode: "mock",
          workerConcurrency: 2,
          maxCanvasRunsPerDay: 50,
          retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 }
        }
      }),
      openSecrets: () => ({
        imagePlannerApiKey: "planner-secret",
        imageProviderApiKey: "provider-secret"
      }),
      createAdapters
    });

    await expect(loader({ kind: "worker_command", commandId: "prompt-test:tmpl_1:v1", idempotencyKey: "prompt-test:idem_4" }))
      .rejects.toThrow("runtime_configuration_unavailable");
    expect(createAdapters).not.toHaveBeenCalled();
  });
});
