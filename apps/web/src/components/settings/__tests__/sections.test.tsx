/**
 * @vitest-environment jsdom
 *
 * Uses within(container) to scope queries to each render, avoiding DOM pollution
 * from previous renders in the same test file when using vmForks pool.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { BasicSettingsSection } from "../sections/basic-settings-section";
import { PricingFormulaSection } from "../sections/pricing-formula-section";
import { ProviderOptionsSection } from "../sections/provider-options-section";
import { RetryPolicySection } from "../sections/retry-policy-section";
import { SecretStatusSection } from "../sections/secret-status-section";
import { SystemDiagnosticsSection } from "../sections/system-diagnostics-section";

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

afterEach(() => {
  cleanup();
});

describe("BasicSettingsSection", () => {
  it("renders all six controls with values from draft", () => {
    const { container } = render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    const ctx = within(container);
    expect(ctx.getAllByDisplayValue("zh-CN")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("CNY")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("mock")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("4")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("50")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("/tmp/assets")[0]).toBeInTheDocument();
  });

  it("calls onFieldChange with dotted key when defaultLocale changes", async () => {
    const user = userEvent.setup();
    const onFieldChange = vi.fn();
    const { container } = render(
      <BasicSettingsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={onFieldChange}
      />
    );
    // Use within to scope query to current render's container
    const ctx = within(container);
    const selects = ctx.getAllByRole("combobox");
    await user.selectOptions(selects[0], "th-TH");
    expect(onFieldChange).toHaveBeenCalledWith("defaultLocale", "th-TH");
  });
});

describe("PricingFormulaSection", () => {
  it("renders all seven pricing fields", () => {
    const { container } = render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    const ctx = within(container);
    expect(ctx.getAllByDisplayValue("8.50")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("35.00")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("10.00")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("0.050")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("0.006")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("0.20")[0]).toBeInTheDocument();
    expect(ctx.getAllByDisplayValue("9")[0]).toBeInTheDocument();
  });

  it("calls onFieldChange with nested key when ending changes", () => {
    const onFieldChange = vi.fn();
    const { container } = render(
      <PricingFormulaSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={onFieldChange}
      />
    );
    // The ending field is the spinbutton with min=0 (unique among pricing spinbuttons)
    const ctx = within(container);
    const spinbuttons = ctx.getAllByRole("spinbutton");
    const endingInput = spinbuttons.find(el => el.getAttribute("min") === "0")!;
    fireEvent.change(endingInput, { target: { value: "5" } });
    expect(onFieldChange).toHaveBeenCalledWith("pricingDefaults.ending", "5");
  });
});

describe("ProviderOptionsSection", () => {
  it("renders provider fields and explains the Canvas runtime boundary", () => {
    const { container } = render(
      <ProviderOptionsSection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    const ctx = within(container);
    expect(ctx.getByDisplayValue("miaoshou")).toBeInTheDocument();
    expect(ctx.getByDisplayValue("v3")).toBeInTheDocument();
    expect(ctx.getByText(/Canvas 当前运行工作流为/)).toBeInTheDocument();
    expect(ctx.getByText(/Worker 实际运行依赖启动配置/)).toBeInTheDocument();
    expect(ctx.queryByDisplayValue("wf-1")).not.toBeInTheDocument();
    expect(ctx.queryByText("参考图")).not.toBeInTheDocument();
    expect(ctx.queryByText("生图风格")).not.toBeInTheDocument();
  });
});

describe("SystemDiagnosticsSection", () => {
  it("links to task logs and shows safe configured status", () => {
    const { container } = render(<SystemDiagnosticsSection draft={viewFixture()} />);
    const ctx = within(container);
    expect(ctx.getByRole("link", { name: "打开任务日志" })).toHaveAttribute("href", "/tasks");
    expect(ctx.getByText("Canvas")).toBeInTheDocument();
    expect(ctx.getByText("妙手")).toBeInTheDocument();
    expect(ctx.getByText("LLM")).toBeInTheDocument();
    expect(ctx.getByText(/TK工作流/)).toBeInTheDocument();
  });
});

describe("RetryPolicySection", () => {
  it("renders maxAttempts and initialDelaySeconds", () => {
    const { container } = render(
      <RetryPolicySection
        draft={viewFixture()}
        dirtyFields={new Set()}
        onFieldChange={() => {}}
      />
    );
    const ctx = within(container);
    expect(ctx.getByDisplayValue("5")).toBeInTheDocument();
    expect(ctx.getByDisplayValue("30")).toBeInTheDocument();
  });
});

describe("SecretStatusSection", () => {
  it("renders four pills with the configured state for each", () => {
    const { container } = render(
      <SecretStatusSection draft={viewFixture()} />
    );
    expect(container.querySelectorAll(".tk-pill.is-ok")).toHaveLength(3);
    expect(container.querySelectorAll(".tk-pill.is-warn")).toHaveLength(1);
    const ctx = within(container);
    expect(ctx.getByText("妙手")).toBeInTheDocument();
    expect(ctx.getByText("Canvas")).toBeInTheDocument();
    expect(ctx.getByText("LLM")).toBeInTheDocument();
    expect(ctx.getByText("汇率")).toBeInTheDocument();
  });
});
