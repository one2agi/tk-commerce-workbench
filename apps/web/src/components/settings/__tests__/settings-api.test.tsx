/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { patchSettings, saveSettings, useSaveSettings } from "../settings-api";

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
    secretStatus: { miaoshouConfigured: true, canvasConfigured: true, llmConfigured: true, exchangeRateConfigured: true },
    applicationNote: ""
  };
}

describe("saveSettings (legacy FormData path)", () => {
  it("posts the form values and expectedVersion to /api/v1/settings", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ...baselineFixture(), version: 2 });
    }) as unknown as typeof fetch;
    const form = new FormData();
    form.set("defaultLocale", "th-TH");
    form.set("defaultCurrency", "THB");
    form.set("externalAdapterMode", "mock");
    form.set("assetRoot", "/tmp/a");
    form.set("workerConcurrency", "4");
    form.set("maxCanvasRunsPerDay", "50");
    form.set("domesticShippingCny", "8.50");
    form.set("crossBorderCostCny", "35.00");
    form.set("fixedTargetCostThb", "10.00");
    form.set("platformFeeRate", "0.050");
    form.set("paymentFeeRate", "0.006");
    form.set("targetProfitRate", "0.20");
    form.set("ending", "9");
    form.set("listingProvider", "miaoshou");
    form.set("listingModel", "v3");
    form.set("canvasWorkflow", "wf-1");
    form.set("maxAttempts", "5");
    form.set("initialDelaySeconds", "30");

    const result = await saveSettings(fetcher, baselineFixture(), form);
    expect(result.ok).toBe(true);
    expect(bodies[0]).toMatchObject({
      expectedVersion: 1,
      defaultLocale: "th-TH"
    });
  });
});

describe("patchSettings", () => {
  it("POSTs the dirty draft fields with expectedVersion", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ...baselineFixture(), version: 2 });
    }) as unknown as typeof fetch;
    const baseline = baselineFixture();
    const draft = { ...baseline, defaultLocale: "th-TH" };
    const result = await patchSettings(fetcher, baseline, draft, new Set(["defaultLocale"]));
    expect(result.ok).toBe(true);
    expect(bodies[0]).toMatchObject({ expectedVersion: 1, defaultLocale: "th-TH" });
  });

  it("returns ok:false with status on non-2xx", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "x" }, { status: 409 })) as unknown as typeof fetch;
    const result = await patchSettings(fetcher, baselineFixture(), baselineFixture(), new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

describe("useSaveSettings", () => {
  it("starts idle and transitions to saving then success", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...baselineFixture(), version: 2 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    expect(result.current.state).toBe("idle");

    let promise: Promise<void>;
    act(() => {
      promise = result.current.save(baselineFixture(), { ...baselineFixture(), defaultLocale: "th-TH" }, new Set(["defaultLocale"]));
    });
    await waitFor(() => expect(result.current.state).toBe("saving"));
    await act(async () => { await promise!; });
    expect(result.current.state).toBe("idle");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("transitions to conflict on 409 and reports the actual version in error", async () => {
    const fetcher = vi.fn(async () => Response.json({ version: 7 }, { status: 409 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    await act(async () => {
      await result.current.save(baselineFixture(), baselineFixture(), new Set());
    });
    expect(result.current.state).toBe("conflict");
    expect(result.current.error).toContain("7");
  });

  it("transitions to error on 5xx", async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 500 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useSaveSettings({ fetcher }));
    await act(async () => {
      await result.current.save(baselineFixture(), baselineFixture(), new Set());
    });
    expect(result.current.state).toBe("error");
  });
});
