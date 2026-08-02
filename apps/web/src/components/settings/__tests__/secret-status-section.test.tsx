/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SecretStatusSection } from "../sections/secret-status-section";

const makeDraft = (secretStatusOverrides = {}) => ({
  version: 1,
  defaultLocale: "th-TH",
  defaultCurrency: "THB",
  externalAdapterMode: "mock" as const,
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
    canvasWorkflow: "TK工作流"
  },
  retryPolicy: { maxAttempts: 3, initialDelaySeconds: 5 },
  secretStatus: {
    miaoshouConfigured: false,
    canvasConfigured: false,
    llmConfigured: false,
    exchangeRateConfigured: false,
    imageGenerationConfigured: false,
    imageGenerationPath: "canvas" as const,
    ...secretStatusOverrides
  },
  applicationNote: ""
});

describe("SecretStatusSection", () => {
  it("shows image generation path as Canvas when imageGenerationPath is canvas", () => {
    render(<SecretStatusSection draft={makeDraft({
      canvasConfigured: true,
      llmConfigured: true,
      imageGenerationConfigured: true,
      imageGenerationPath: "canvas"
    })} />);
    expect(screen.getByText("Canvas")).toBeInTheDocument();
    expect(screen.getByText("图片生成已配置")).toBeInTheDocument();
  });

  it("shows image generation path as 无头 when imageGenerationPath is headless", () => {
    render(<SecretStatusSection draft={makeDraft({
      canvasConfigured: true,
      llmConfigured: true,
      imageGenerationConfigured: true,
      imageGenerationPath: "headless"
    })} />);
    expect(screen.getByText("无头")).toBeInTheDocument();
    expect(screen.getByText("图片生成已配置")).toBeInTheDocument();
  });

  it("does not show 图片生成已配置 when image generation is not configured", () => {
    const { container } = render(<SecretStatusSection draft={makeDraft({
      canvasConfigured: false,
      llmConfigured: false,
      exchangeRateConfigured: false,
      imageGenerationConfigured: false,
      imageGenerationPath: "canvas"
    })} />);
    expect(container.textContent).not.toContain("图片生成已配置");
  });

  it("includes imageGenerationConfigured and imageGenerationPath in secretStatus", () => {
    const draft = makeDraft({
      imageGenerationConfigured: true,
      imageGenerationPath: "headless"
    });
    expect(draft.secretStatus.imageGenerationConfigured).toBe(true);
    expect(draft.secretStatus.imageGenerationPath).toBe("headless");
  });
});
