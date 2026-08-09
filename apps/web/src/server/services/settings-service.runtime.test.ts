import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import type { PublicServiceConfigurationV1 } from "../../../../../packages/contracts/src/runtime-configuration.js";
import { createRuntimeSecretCodec } from "../../../../../packages/config/src/runtime-secrets.js";
import {
  SettingsService,
  SettingsValidationError,
  type SettingsStore,
  type WorkspaceSettingsRecord
} from "./settings-service.js";

const PUBLIC_CONFIG: PublicServiceConfigurationV1 = {
  imageGenerationPath: "headless",
  imagePlannerBaseUrl: "https://planner.test/v1",
  imagePlannerModel: "planner-v1",
  imageProviderBaseUrl: "https://images.test/v1",
  imageProviderModel: "image-v1",
  canvasBaseUrl: "",
  canvasId: "canvas-1",
  canvasWorkflowName: "TK工作流",
  llmBaseUrl: "https://llm.test/v1",
  llmModel: "listing-v1",
  exchangeRateBaseUrl: "https://rates.test",
  miaoshouBaseUrl: "https://miaoshou.test",
  miaoshouAccountId: "account-1",
  assetPublishS3Endpoint: "",
  assetPublishS3Region: "",
  assetPublishS3Bucket: "",
  assetPublishPublicBaseUrl: ""
};

const codec = createRuntimeSecretCodec(Buffer.alloc(32, 5).toString("base64"));

function baseRecord(): WorkspaceSettingsRecord {
  return {
    version: 1,
    defaultLocale: "th-TH",
    defaultCurrency: "THB",
    externalAdapterMode: "live",
    workerConcurrency: 2,
    maxCanvasRunsPerDay: 50,
    assetRoot: "./data/assets",
    pricingDefaults: {
      domesticShippingCny: "2.00", crossBorderCostCny: "6.00", fixedTargetCostThb: "10.00",
      platformFeeRate: "0.05", paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9"
    },
    providerOptions: {
      listingProvider: "rules", listingModel: "rules-v1", canvasWorkflow: "TK工作流",
      imageGenerationPath: "headless", imagePlannerModel: "planner-v1", imageProviderModel: "image-v1"
    },
    retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 },
    serviceConfiguration: PUBLIC_CONFIG,
    encryptedSecrets: codec.seal({
      imagePlannerApiKey: "old-planner-secret",
      imageProviderApiKey: "old-provider-secret",
      llmApiKey: "listing-secret",
      miaoshouAppKey: "miaoshou-key",
      miaoshouAppSecret: "miaoshou-secret",
      extensionToken: "extension-secret"
    }, "workspace_settings:1")
  };
}

class MemoryStore implements SettingsStore {
  record = baseRecord();
  async initialize(): Promise<void> {}
  async get(): Promise<WorkspaceSettingsRecord> { return this.record; }
  async update(expectedVersion: number, next: Omit<WorkspaceSettingsRecord, "version">) {
    if (expectedVersion !== this.record.version) return undefined;
    this.record = { ...next, version: expectedVersion + 1 };
    return this.record;
  }
}

function service(store: MemoryStore): SettingsService {
  return new SettingsService(store, {
    defaults: { ...baseRecord(), version: undefined } as never,
    secretStatus: {
      miaoshouConfigured: false, canvasConfigured: false, llmConfigured: true,
      exchangeRateConfigured: true, imageGenerationConfigured: true, imageGenerationPath: "headless"
    },
    secretCodec: codec,
    loadApplyStatus: async () => ({
      appliedVersion: 1, candidateVersion: 1, state: "applied", errorCode: null
    })
  });
}

describe("SettingsService runtime configuration", () => {
  it("retains omitted secrets, replaces requested secrets and never returns plaintext", async () => {
    const store = new MemoryStore();
    const view = await service(store).update({
      expectedVersion: 1,
      secretMutations: {
        imageProviderApiKey: { action: "replace", value: "new-provider-secret" }
      }
    });

    expect(view.serviceSecretStatus).toMatchObject({
      imagePlannerApiKey: true,
      imageProviderApiKey: true,
      extensionToken: true
    });
    expect(JSON.stringify(view)).not.toContain("new-provider-secret");
    expect(JSON.stringify(view)).not.toContain("old-planner-secret");
    expect(codec.open(store.record.encryptedSecrets!, "workspace_settings:1")).toMatchObject({
      imagePlannerApiKey: "old-planner-secret",
      imageProviderApiKey: "new-provider-secret"
    });
  });

  it("blocks clearing a credential required by active headless live mode", async () => {
    const store = new MemoryStore();

    await expect(service(store).update({
      expectedVersion: 1,
      secretMutations: { imageProviderApiKey: { action: "clear" } }
    })).rejects.toEqual(expect.objectContaining<Partial<SettingsValidationError>>({
      code: "image_provider_api_key_required",
      field: "imageProviderApiKey"
    }));
    expect(store.record.version).toBe(1);
  });

  it("validates changed public provider configuration even when secrets are retained", async () => {
    const store = new MemoryStore();

    await expect(service(store).update({
      expectedVersion: 1,
      serviceConfiguration: { ...PUBLIC_CONFIG, imageProviderBaseUrl: "" }
    })).rejects.toEqual(expect.objectContaining<Partial<SettingsValidationError>>({
      code: "image_provider_base_url_required",
      field: "imageProviderBaseUrl"
    }));
    expect(store.record.version).toBe(1);
  });

  it("returns saved and Worker-applied versions independently", async () => {
    const view = await service(new MemoryStore()).get();

    expect(view.runtimeStatus).toMatchObject({
      savedVersion: 1,
      appliedVersion: 1,
      applyState: "applied",
      applyErrorCode: null
    });
  });
});
