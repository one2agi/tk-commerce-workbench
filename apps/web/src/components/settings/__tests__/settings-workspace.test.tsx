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
    providerOptions: {
      listingProvider: "miaoshou",
      listingModel: "v3",
      canvasWorkflow: "wf-1",
      imageGenerationPath: "headless",
      imagePlannerModel: "planner-v4",
      imageProviderModel: "image-v2"
    },
    retryPolicy: { maxAttempts: 5, initialDelaySeconds: 30 },
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: false, imageGenerationConfigured: true, imageGenerationPath: "headless" },
    runtimeStatus: {
      active: {
        externalAdapterMode: "mock",
        workerConcurrency: 4,
        maxCanvasRunsPerDay: 50,
        assetRoot: "/tmp/assets",
        imageGenerationPath: "canvas",
        imagePlannerModel: "planner-v1",
        imageProviderModel: "image-v1",
        canvasWorkflow: "wf-1",
        imageGenerationConfigured: true
      },
      restartRequiredFields: [
        "providerOptions.imageGenerationPath",
        "providerOptions.imagePlannerModel",
        "providerOptions.imageProviderModel"
      ]
    },
    applicationNote: "启动型配置需同步到运行环境并重启 Worker 后才会应用。"
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

  it("renders the production settings navigation, runtime status and no save bar", () => {
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(ctx.getAllByText("基础设置")).not.toHaveLength(0);
    expect(ctx.queryByText("定价公式")).not.toBeInTheDocument();
    expect(ctx.getByRole("navigation", { name: "设置分区" })).toBeInTheDocument();
    expect(ctx.getAllByText("生图路径")).not.toHaveLength(0);
    expect(ctx.getAllByText("外部服务")).not.toHaveLength(0);
    expect(ctx.getAllByText("稳定性")).not.toHaveLength(0);
    expect(ctx.getAllByText("应用状态")).not.toHaveLength(0);
    expect(ctx.getByText("配置应用状态")).toBeInTheDocument();
    expect(ctx.getByText("等待 Worker 自动应用")).toBeInTheDocument();
    expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("shows headless model controls and switches to Canvas compatibility controls", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);

    expect(ctx.getByLabelText("Planner 模型")).toHaveValue("planner-v4");
    expect(ctx.getByLabelText("图片模型")).toHaveValue("image-v2");
    await user.click(ctx.getByRole("radio", { name: /Canvas 兼容/ }));
    expect(ctx.queryByLabelText("Planner 模型")).not.toBeInTheDocument();
    expect(ctx.getByLabelText("Canvas 工作流")).toHaveValue("wf-1");
    expect(ctx.getByLabelText("Canvas 每日上限")).toHaveAttribute("min", "0");
  });

  it("validates required headless models and focuses the first invalid field", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn() as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const planner = ctx.getByLabelText("Planner 模型");
    await user.clear(planner);
    await user.click(ctx.getByRole("button", { name: "保存更改" }));

    expect(planner).toHaveFocus();
    expect(ctx.getByText("请输入 Planner 模型 ID")).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes task logs through safe Worker status instead of template-style controls", () => {
    const { container } = render(<SettingsWorkspace initial={baseline()} />);
    const ctx = within(container);
    expect(ctx.getByRole("link", { name: "打开任务日志" })).toHaveAttribute("href", "/tasks");
    expect(ctx.getByText("密钥只显示配置状态；已有值不会回显。输入新值后保存即可替换。")).toBeInTheDocument();
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

    await user.click(ctx.getByRole("button", { name: "放弃更改" }));

    expect(ctx.getByDisplayValue("zh-CN")).toBeInTheDocument();
    expect(maxAttemptsInput).toHaveValue(5);
    expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
  });

  it("applies an immediately resolved PATCH result without observing a rendered saving state", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ ...baseline(), defaultLocale: "th-TH", version: 13 }))) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    await user.click(ctx.getByRole("button", { name: "保存更改" }));

    await waitFor(() => {
      expect(ctx.queryByRole("region", { name: "保存栏" })).toBeNull();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const savedStatus = ctx.getByRole("status");
    expect(savedStatus).toHaveTextContent(/更改已保存/);
    expect(savedStatus).toHaveTextContent(/v13/); // server-returned version, not draft.version (12)
  });

  it("PATCH 409 keeps the save bar visible and shows conflict copy", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async () => Response.json({ actualVersion: 7 }, { status: 409 })) as unknown as typeof fetch;
    const { container } = render(<SettingsWorkspace initial={baseline()} fetcher={fetcher} />);
    const ctx = within(container);
    const localeSelect = ctx.getAllByRole("combobox")[0];
    await user.selectOptions(localeSelect, "th-TH");
    await user.click(ctx.getByRole("button", { name: "保存更改" }));

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
    await user.click(ctx.getByRole("button", { name: "保存更改" }));

    await waitFor(() => {
      expect(ctx.getByRole("region", { name: "保存栏" })).toHaveTextContent(/设置未保存/);
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
