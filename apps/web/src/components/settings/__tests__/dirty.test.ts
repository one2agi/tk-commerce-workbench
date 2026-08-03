import { describe, expect, it } from "vitest";

import { computeDirtyFields, setNestedField } from "../dirty";
import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

function baselineFixture(): WorkspaceSettingsView {
  return {
    version: 1,
    defaultLocale: "zh-CN",
    defaultCurrency: "CNY",
    externalAdapterMode: "mock",
    workerConcurrency: 4,
    maxCanvasRunsPerDay: 50,
    assetRoot: "/tmp/assets",
    pricingDefaults: {
      domesticShippingCny: "8.50",
      crossBorderCostCny: "35.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.050",
      paymentFeeRate: "0.006",
      targetProfitRate: "0.20",
      ending: "9"
    },
    providerOptions: { listingProvider: "miaoshou", listingModel: "v3", canvasWorkflow: "wf-1" },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true, imageGenerationConfigured: true, imageGenerationPath: "headless" },
    applicationNote: ""
  };
}

describe("setNestedField", () => {
  it("sets a top-level field immutably", () => {
    const before = baselineFixture();
    const after = setNestedField(before, "defaultLocale", "th-TH");
    expect(after).not.toBe(before);
    expect(after.defaultLocale).toBe("th-TH");
    expect(before.defaultLocale).toBe("zh-CN");
  });

  it("sets a nested field immutably without mutating siblings", () => {
    const before = baselineFixture();
    const after = setNestedField(before, "pricingDefaults.targetProfitRate", "0.30");
    expect(after.pricingDefaults).not.toBe(before.pricingDefaults);
    expect(after.pricingDefaults.targetProfitRate).toBe("0.30");
    expect(after.pricingDefaults.platformFeeRate).toBe("0.050");
    expect(before.pricingDefaults.targetProfitRate).toBe("0.20");
  });
});

describe("computeDirtyFields", () => {
  it("returns an empty set when draft equals baseline", () => {
    const b = baselineFixture();
    expect(computeDirtyFields(b, { ...b }).size).toBe(0);
  });

  it("detects a top-level scalar change", () => {
    const b = baselineFixture();
    const dirty = computeDirtyFields(b, { ...b, defaultLocale: "en-US" });
    expect([...dirty]).toEqual(["defaultLocale"]);
  });

  it("detects a nested change and reports dotted key", () => {
    const b = baselineFixture();
    const draft = { ...b, pricingDefaults: { ...b.pricingDefaults, ending: "5" } };
    const dirty = computeDirtyFields(b, draft);
    expect([...dirty]).toEqual(["pricingDefaults.ending"]);
  });

  it("reports multiple dirty fields", () => {
    const b = baselineFixture();
    const draft = {
      ...b,
      externalAdapterMode: "live" as const,
      pricingDefaults: { ...b.pricingDefaults, ending: "5", platformFeeRate: "0.060" }
    };
    const dirty = computeDirtyFields(b, draft);
    expect([...dirty].sort()).toEqual([
      "externalAdapterMode",
      "pricingDefaults.ending",
      "pricingDefaults.platformFeeRate"
    ]);
  });
});
