/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { SecretStatusSection } from "../sections/secret-status-section";

function makeDraft(imageGenerationConfigured: boolean): WorkspaceSettingsView {
  return {
    version: 1,
    defaultLocale: "th-TH",
    defaultCurrency: "THB",
    externalAdapterMode: "mock",
    workerConcurrency: 2,
    maxCanvasRunsPerDay: 50,
    assetRoot: "./data/assets",
    pricingDefaults: {
      domesticShippingCny: "0",
      crossBorderCostCny: "0",
      fixedTargetCostThb: "0",
      platformFeeRate: "0.05",
      paymentFeeRate: "0.03",
      targetProfitRate: "0.30",
      ending: "9"
    },
    providerOptions: {
      listingProvider: "rules",
      listingModel: "",
      canvasWorkflow: "TK工作流",
      imageGenerationPath: "headless",
      imagePlannerModel: "planner",
      imageProviderModel: "image"
    },
    retryPolicy: { maxAttempts: 3, initialDelaySeconds: 5 },
    secretStatus: {
      miaoshouConfigured: false,
      canvasConfigured: true,
      llmConfigured: true,
      exchangeRateConfigured: false,
      imageGenerationConfigured,
      imageGenerationPath: "headless"
    },
    runtimeStatus: {
      active: {
        externalAdapterMode: "mock",
        workerConcurrency: 2,
        maxCanvasRunsPerDay: 50,
        assetRoot: "./data/assets",
        imageGenerationPath: "headless",
        imagePlannerModel: "planner",
        imageProviderModel: "image",
        canvasWorkflow: "TK工作流",
        imageGenerationConfigured
      },
      restartRequiredFields: []
    },
    applicationNote: ""
  };
}

describe("SecretStatusSection", () => {
  it("shows the active headless image-generation readiness", () => {
    const { container } = render(<SecretStatusSection draft={makeDraft(true)} />);

    expect(screen.getByText("Headless 生图")).toBeInTheDocument();
    expect(container.querySelectorAll(".tk-pill.is-ok")).toHaveLength(3);
  });

  it("shows a warning when headless image generation is not ready", () => {
    const { container } = render(<SecretStatusSection draft={makeDraft(false)} />);

    expect(container.querySelectorAll(".tk-pill.is-warn")).toHaveLength(3);
  });
});
