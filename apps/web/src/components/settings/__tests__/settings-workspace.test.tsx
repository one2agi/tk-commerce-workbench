/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { SettingsWorkspace } from "../settings-workspace";

function baseline(): WorkspaceSettingsView {
  return {
    version: 12,
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
    applicationNote: ""
  };
}

describe("SettingsWorkspace", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
    removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("renders all five cards with the initial values and no save bar", () => {
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(ctx.getByText("基础设置")).toBeInTheDocument();
    expect(ctx.getByText("定价公式")).toBeInTheDocument();
    expect(ctx.getByText("Provider 默认值")).toBeInTheDocument();
    expect(ctx.getByText("重试策略")).toBeInTheDocument();
    expect(ctx.getByText("密钥配置状态")).toBeInTheDocument();
    expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("shows save bar with dirty count after editing one field", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    // The locale select is the first combobox in the basic settings card
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    const saveBar = await ctx.findByRole("region", { name: "保存栏" });
    expect(saveBar).toHaveTextContent(/已修改/);
    expect(saveBar).toHaveTextContent(/1/);
    expect(saveBar).toHaveTextContent(/v12/);
  });

  it("discard reverts all fields and hides the save bar", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "en-US");
    // The "ending" field is a spinbutton; find the one with value "9"
    const allSpinbuttons = ctx.getAllByRole("spinbutton");
    const endingInput = allSpinbuttons.find((el) => (el as HTMLInputElement).value === "9");
    if (!endingInput) throw new Error("Could not find ending input with value 9");
    await user.clear(endingInput);
    await user.type(endingInput, "5");

    const saveBar = ctx.getByRole("region", { name: "保存栏" });
    expect(saveBar).toHaveTextContent(/2/);

    await user.click(ctx.getByRole("button", { name: "放弃修改" }));

    expect(ctx.getByDisplayValue("zh-CN")).toBeInTheDocument();
    expect(ctx.getByDisplayValue("9")).toBeInTheDocument();
    expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("PATCH on save returns 200 → bar hides, version updates, toast appears", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({ ...baseline(), defaultLocale: "th-TH", version: 13 })) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    await user.click(ctx.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ctx.getByText(/已保存/)).toBeInTheDocument();
    expect(ctx.getByText(/v13/)).toBeInTheDocument(); // server-returned version, not draft.version (12)
  });

  it("PATCH 409 keeps the save bar visible and shows conflict copy", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({ actualVersion: 7 }, { status: 409 })) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    await user.click(ctx.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(ctx.getByRole("region", { name: "保存栏" })).toHaveTextContent(/v7/);
    });
  });

  it("PATCH 500 keeps draft and shows error copy", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    await user.click(ctx.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(ctx.getByRole("region", { name: "保存栏" })).toHaveTextContent(/保存失败/);
    });
    expect(ctx.getByDisplayValue("th-TH")).toBeInTheDocument();
  });

  it("⌘+S triggers save when dirty and idle", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...baseline(), version: 13 })) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await userEvent.setup().selectOptions(localeSelect, "th-TH");
    act(() => {
      fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
  });

  it("⌘+S in idle state does NOT trigger save", () => {
    const fetcher = vi.fn(async () => Response.json(baseline())) as unknown as typeof fetch;
    render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("registers a beforeunload listener only while dirty", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(addEventListenerSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    expect(addEventListenerSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });
});
