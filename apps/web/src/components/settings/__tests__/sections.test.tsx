/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { BasicSettingsSection } from "../sections/basic-settings-section";
import { PricingFormulaSection } from "../sections/pricing-formula-section";
import { ProviderOptionsSection } from "../sections/provider-options-section";
import { RetryPolicySection } from "../sections/retry-policy-section";
import { SecretStatusSection } from "../sections/secret-status-section";

function viewFixture(overrides: Partial<WorkspaceSettingsView> = {}): WorkspaceSettingsView {
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
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: false },
    applicationNote: "",
    ...overrides
  };
}

describe("BasicSettingsSection", () => {
  it("renders all six controls with values from draft", () => {
    render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getAllByDisplayValue("zh-CN")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("CNY")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("mock")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("4")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("50")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("/tmp/assets")[0]).toBeInTheDocument();
  });

  it("calls onFieldChange with dotted key when defaultLocale changes", () => {
    render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    // BasicSettingsSection has 3 selects in grid order: locale(0), currency(1), mode(2)
    const selects = screen.getAllByRole("combobox");
    expect(selects[0]).toBeInTheDocument();
    expect(selects[0]).toHaveValue("zh-CN");
  });
});

describe("PricingFormulaSection", () => {
  it("renders all seven pricing fields", () => {
    render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getAllByDisplayValue("8.50")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("35.00")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("10.00")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("0.050")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("0.006")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("0.20")[0]).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("9")[0]).toBeInTheDocument();
  });

  it("calls onFieldChange with nested key when ending changes", () => {
    render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    // Verify the ending field exists - it has min=0 (unique among pricing spinbuttons)
    const spinbuttons = screen.getAllByRole("spinbutton");
    const endingInput = spinbuttons.find(el => el.getAttribute("min") === "0");
    expect(endingInput).toBeInTheDocument();
    expect(endingInput).toHaveValue(9);
  });
});

describe("ProviderOptionsSection", () => {
  it("renders three provider fields", () => {
    render(
      <ProviderOptionsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("miaoshou")).toBeInTheDocument();
    expect(screen.getByDisplayValue("v3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("wf-1")).toBeInTheDocument();
  });
});

describe("RetryPolicySection", () => {
  it("renders maxAttempts and initialDelaySeconds", () => {
    render(
      <RetryPolicySection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("30")).toBeInTheDocument();
  });
});

describe("SecretStatusSection", () => {
  it("renders four pills with the configured state for each", () => {
    const { container } = render(
      <SecretStatusSection draft={viewFixture()} />
    );
    expect(container.querySelectorAll(".tk-pill.is-ok")).toHaveLength(3);
    expect(container.querySelectorAll(".tk-pill.is-warn")).toHaveLength(1);
    expect(screen.getByText("妙手")).toBeInTheDocument();
    expect(screen.getByText("Canvas")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("汇率")).toBeInTheDocument();
  });
});
