import { describe, expect, it, vi } from "vitest";

import { saveSettings } from "./settings/settings-editor";
import { saveTemplate } from "./templates/template-manager";

describe("continuous operations edits", () => {
  it("uses the returned settings version for a second save without losing form values", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ ...settings, ...body, version: bodies.length + 1 });
    }) as unknown as typeof fetch;
    const form = settingsForm("vi-VN");
    const first = await saveSettings(fetcher, settings, form);
    if (!first.ok) throw new Error("first save failed");
    const second = await saveSettings(fetcher, first.value, form);
    if (!second.ok) throw new Error("second save failed");

    expect(bodies.map((body) => body.expectedVersion)).toEqual([1, 2]);
    expect(bodies.map((body) => body.defaultLocale)).toEqual(["vi-VN", "vi-VN"]);
    expect(second.value.version).toBe(3);
  });

  it("uses the returned template version for consecutive immutable edits", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ ...template, ...body, version: bodies.length + 1 });
    }) as unknown as typeof fetch;
    const form = new FormData();
    Object.entries({
      name: "TK", categoryRules: "dress", referenceAssetIds: "asset-ref",
      promptFragment: "summer prompt", targetLocale: "vi-VN", visualStyle: "premium", enabled: "on"
    }).forEach(([key, value]) => form.set(key, value));
    const first = await saveTemplate(fetcher, template, form);
    if (!first.ok) throw new Error("first save failed");
    const second = await saveTemplate(fetcher, first.value, form);
    if (!second.ok) throw new Error("second save failed");

    expect(bodies.map((body) => body.expectedVersion)).toEqual([1, 2]);
    expect(bodies.map((body) => body.promptFragment)).toEqual(["summer prompt", "summer prompt"]);
    expect(second.value.version).toBe(3);
  });
});

function settingsForm(locale: string) {
  const form = new FormData();
  Object.entries({
    defaultLocale: locale, defaultCurrency: "THB", externalAdapterMode: "mock", assetRoot: "./assets",
    workerConcurrency: "2", maxCanvasRunsPerDay: "50", domesticShippingCny: "2.00",
    crossBorderCostCny: "6.00", fixedTargetCostThb: "10.00", platformFeeRate: "0.05",
    paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9", listingProvider: "rules",
    listingModel: "rules-v1", canvasWorkflow: "TK工作流", maxAttempts: "3", initialDelaySeconds: "30"
  }).forEach(([key, value]) => form.set(key, value));
  return form;
}

const settings = {
  version: 1, defaultLocale: "th-TH", defaultCurrency: "THB", externalAdapterMode: "mock" as const,
  workerConcurrency: 2, maxCanvasRunsPerDay: 50, assetRoot: "./assets",
  pricingDefaults: { domesticShippingCny: "2.00", crossBorderCostCny: "6.00", fixedTargetCostThb: "10.00", platformFeeRate: "0.05", paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9" },
  providerOptions: { listingProvider: "rules", listingModel: "rules-v1", canvasWorkflow: "TK工作流" },
  retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 },
  secretStatus: { miaoshouConfigured: false, canvasConfigured: false, llmConfigured: false, exchangeRateConfigured: false },
  applicationNote: "workspace defaults"
};

const template = {
  templateId: "template-one" as never, name: "TK", categoryRules: [], referenceAssetIds: [],
  promptFragment: "clean", targetLocale: "th-TH", visualStyle: "marketplace", enabled: true, version: 1
};
