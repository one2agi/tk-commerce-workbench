import { describe, expect, it } from "vitest";

import {
  SettingsConflictError,
  SettingsService,
  type WorkspaceSettingsRecord
} from "./settings-service";
import {
  TemplateConflictError,
  TemplateService,
  type TemplateRecord
} from "./template-service";

class MemorySettingsStore {
  record: WorkspaceSettingsRecord | undefined;

  async initialize(defaults: WorkspaceSettingsRecord): Promise<void> {
    this.record ??= structuredClone(defaults);
  }

  async get(): Promise<WorkspaceSettingsRecord | undefined> {
    return this.record && structuredClone(this.record);
  }

  async update(expectedVersion: number, next: Omit<WorkspaceSettingsRecord, "version">) {
    if (!this.record || this.record.version !== expectedVersion) return undefined;
    this.record = { ...structuredClone(next), version: expectedVersion + 1 };
    return structuredClone(this.record);
  }
}

class MemoryTemplateStore {
  readonly records: TemplateRecord[] = [];

  async list(): Promise<TemplateRecord[]> {
    return structuredClone(this.records).sort((a, b) => b.version - a.version);
  }

  async create(record: TemplateRecord): Promise<TemplateRecord> {
    this.records.push(structuredClone(record));
    return structuredClone(record);
  }

  async appendVersion(templateId: string, expectedVersion: number, record: TemplateRecord) {
    const latest = this.records
      .filter((item) => item.templateId === templateId)
      .sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.version !== expectedVersion) return undefined;
    this.records.push(structuredClone(record));
    return structuredClone(record);
  }
}

const runtime = {
  defaults: {
    defaultLocale: "th-TH",
    defaultCurrency: "THB",
    externalAdapterMode: "mock" as const,
    workerConcurrency: 2,
    maxCanvasRunsPerDay: 50,
    assetRoot: "./data/assets",
    pricingDefaults: {
      domesticShippingCny: "2.00",
      crossBorderCostCny: "6.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.05",
      paymentFeeRate: "0.03",
      targetProfitRate: "0.30",
      ending: "9"
    },
    providerOptions: {
      listingProvider: "rules",
      listingModel: "rules-v1",
      canvasWorkflow: "TK工作流"
    },
    retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 }
  },
  secretStatus: {
    miaoshouConfigured: true,
    canvasConfigured: false,
    llmConfigured: false,
    exchangeRateConfigured: true,
    imageGenerationConfigured: true,
    imageGenerationPath: "headless" as const
  }
};

describe("workspace settings", () => {
  it("persists non-secret defaults and reads them through a new service instance", async () => {
    const store = new MemorySettingsStore();
    const first = new SettingsService(store, runtime);
    expect((await first.get()).version).toBe(1);

    await first.update({
      expectedVersion: 1,
      defaultLocale: "vi-VN",
      workerConcurrency: 4,
      pricingDefaults: { ...runtime.defaults.pricingDefaults, targetProfitRate: "0.35" }
    });

    const restarted = new SettingsService(store, runtime);
    expect(await restarted.get()).toMatchObject({
      version: 2,
      defaultLocale: "vi-VN",
      workerConcurrency: 4,
      pricingDefaults: { targetProfitRate: "0.35" },
      secretStatus: runtime.secretStatus
    });
  });

  it("rejects a stale settings update instead of overwriting a newer save", async () => {
    const service = new SettingsService(new MemorySettingsStore(), runtime);
    await service.get();
    await service.update({ expectedVersion: 1, assetRoot: "./assets/new" });
    await expect(service.update({ expectedVersion: 1, assetRoot: "./assets/stale" }))
      .rejects.toBeInstanceOf(SettingsConflictError);
  });
});

describe("template versions", () => {
  it("appends an immutable version and preserves the prior version", async () => {
    const store = new MemoryTemplateStore();
    const service = new TemplateService(store, () => "generated-id");
    const created = await service.create({
      name: "TK",
      categoryRules: [{ categoryKey: "women_dress", priority: 10 }],
      referenceAssetIds: ["asset-one"],
      promptFragment: "clean background",
      targetLocale: "th-TH",
      visualStyle: "marketplace",
      enabled: true
    });
    await service.update({
      templateId: created.templateId,
      expectedVersion: 1,
      promptFragment: "summer marketplace"
    });

    const items = (await service.list()).items;
    expect(items.map((item) => [item.version, item.promptFragment])).toEqual([
      [2, "summer marketplace"],
      [1, "clean background"]
    ]);
  });

  it("rejects a stale template edit without creating a third version", async () => {
    const store = new MemoryTemplateStore();
    const service = new TemplateService(store, () => `generated-${store.records.length}`);
    const created = await service.create({
      name: "TK", categoryRules: [], referenceAssetIds: [], promptFragment: "v1",
      targetLocale: "th-TH", visualStyle: "clean", enabled: true
    });
    await service.update({ templateId: created.templateId, expectedVersion: 1, promptFragment: "v2" });
    await expect(service.update({ templateId: created.templateId, expectedVersion: 1, promptFragment: "stale" }))
      .rejects.toBeInstanceOf(TemplateConflictError);
    expect(store.records).toHaveLength(2);
  });
});
