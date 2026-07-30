/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
    cleanup();
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it("renders the approved settings cards with diagnostics and no save bar", () => {
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(ctx.getByText("基础设置")).toBeInTheDocument();
    expect(ctx.queryByText("定价公式")).not.toBeInTheDocument();
    expect(ctx.getByText("处理运行边界")).toBeInTheDocument();
    expect(ctx.getByText("重试策略")).toBeInTheDocument();
    expect(ctx.getByText("密钥配置状态")).toBeInTheDocument();
    expect(ctx.getByRole("region", { name: "系统诊断" })).toBeInTheDocument();
    expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("exposes task logs through system diagnostics instead of template-style controls", () => {
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(ctx.getByRole("region", { name: "系统诊断" })).toBeInTheDocument();
    expect(ctx.getByRole("link", { name: "打开任务日志" })).toHaveAttribute("href", "/tasks");
    expect(ctx.queryByText("参考图")).not.toBeInTheDocument();
    expect(ctx.queryByText("生图风格")).not.toBeInTheDocument();
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
    const maxAttemptsInput = ctx.getAllByRole("spinbutton")
      .find((element) => (element as HTMLInputElement).value === "5");
    if (!maxAttemptsInput) throw new Error("Could not find max-attempts input with value 5");
    await user.clear(maxAttemptsInput);
    await user.type(maxAttemptsInput, "6");

    const saveBar = ctx.getByRole("region", { name: "保存栏" });
    expect(saveBar).toHaveTextContent(/2/);

    await user.click(ctx.getByRole("button", { name: "放弃修改" }));

    expect(ctx.getByDisplayValue("zh-CN")).toBeInTheDocument();
    expect(maxAttemptsInput).toHaveValue(5);
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
