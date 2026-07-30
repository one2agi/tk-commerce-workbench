// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createChromeCaptureTabPort, type ChromeTabsApi } from "./chrome-capture-tab-port.js";

function completeCapture() {
  return {
    sourceItemId: "892408514788",
    sourceUrl: "https://detail.1688.com/offer/892408514788.html",
    title: "测试商品",
    mainImages: ["https://img.test/main.jpg"],
    detailImages: [],
    itemNumber: null,
    category: null,
    sourcePriceWire: null,
    sourcePriceRangeWire: null,
    sourceStock: null,
    weightKg: null,
    dimensionsCm: null,
    attributes: [],
    saleAttributes: [],
    skuText: [],
    capturedAt: "2026-07-24T08:00:00.000Z",
    captureQuality: "detail_page_complete" as const,
    skuAttributes: [],
    colors: [],
    sizes: [],
    skus: [],
    diagnostics: {
      version: 2 as const,
      pageKind: "offer_detail" as const,
      titleSource: "page_context" as const,
      stableForMs: 2000,
      fieldEvidence: {
        title: "captured" as const,
        mainImages: "captured" as const,
        detail: "source_absent" as const,
        attributes: "source_absent" as const,
        price: "source_absent" as const,
        stock: "source_absent" as const,
        skus: "source_absent" as const,
        weight: "source_absent" as const,
        dimensions: "source_absent" as const
      },
      expectedSkuCount: null,
      capturedSkuCount: 0,
      acceptedMainImages: 1,
      acceptedDetailImages: 0,
      rejectedImages: 0,
      warnings: []
    }
  };
}

describe("Chrome detail capture tab port", () => {
  it("does not retry after the detail content script returns a parser result", async () => {
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "detail_images_missing" }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const delay = vi.fn(async () => undefined);
    const port = createChromeCaptureTabPort(tabs, { retryDelayMs: 1, delay });

    await expect(port.capture(7)).rejects.toThrow("detail_images_missing");
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("times out a hanging content-script response instead of loading forever", async () => {
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn(() => new Promise(() => undefined)),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const port = createChromeCaptureTabPort(tabs, { timeoutMs: 5, captureResponseGraceMs: 0 });

    await expect(port.capture(7)).rejects.toThrow("detail_capture_timeout");
  });

  it("gives the content parser a short grace window beyond the page timeout", async () => {
    const complete = completeCapture();
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, capture: complete }), 8);
      })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const port = createChromeCaptureTabPort(tabs, { timeoutMs: 5, captureResponseGraceMs: 20 });

    await expect(port.capture(7)).resolves.toEqual(complete);
  });

  it("retries when the detail content script is not ready yet", async () => {
    const complete = completeCapture();
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
        .mockResolvedValueOnce({ ok: true, capture: complete }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const delay = vi.fn(async () => undefined);
    const port = createChromeCaptureTabPort(tabs, { retryDelayMs: 1, delay });

    await expect(port.capture(7)).resolves.toEqual(complete);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it("supports callback-style tabs.sendMessage responses used by some Chromium extension runtimes", async () => {
    const complete = completeCapture();
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn((_tabId, _message, callback) => {
        callback({ ok: true, capture: complete });
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const port = createChromeCaptureTabPort(tabs, { timeoutMs: 5 });

    await expect(port.capture(7)).resolves.toEqual(complete);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("injects the detail content script before retrying a missing receiver", async () => {
    const complete = completeCapture();
    const tabs = {
      create: vi.fn(),
      remove: vi.fn(),
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
        .mockResolvedValueOnce({ ok: true, capture: complete }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() }
    } as unknown as ChromeTabsApi;
    const injectContentScript = vi.fn(async () => undefined);
    const delay = vi.fn(async () => undefined);
    const port = createChromeCaptureTabPort(tabs, {
      retryDelayMs: 1,
      delay,
      injectContentScript
    });

    await expect(port.capture(7)).resolves.toEqual(complete);
    expect(injectContentScript).toHaveBeenCalledWith(7);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
});
