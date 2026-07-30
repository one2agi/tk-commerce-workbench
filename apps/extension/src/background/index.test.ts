// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createBackgroundMessageHandler, executePageContextBridge } from "./index.js";

function completeCapture() {
  return {
    sourceItemId: "892408514788",
    sourceUrl: "https://detail.1688.com/offer/892408514788.html",
    title: "测试商品",
    mainImages: ["https://img.test/main.jpg"],
    detailImages: [],
    itemNumber: null,
    category: null,
    sourcePriceWire: { amountMinor: "1350", currency: "CNY" as const },
    sourcePriceRangeWire: {
      minAmountMinor: "1350",
      maxAmountMinor: "1350",
      currency: "CNY" as const
    },
    sourceStock: 159,
    weightKg: null,
    dimensionsCm: null,
    attributes: [],
    saleAttributes: [],
    skuText: ["颜色: 银色"],
    capturedAt: "2026-07-24T08:00:00.000Z",
    captureQuality: "detail_page_complete" as const,
    skuAttributes: [{ name: "颜色", values: [{ name: "银色" }] }],
    colors: ["银色"],
    sizes: [],
    skus: [{
      skuId: "sku-silver",
      attributes: { 颜色: "银色" },
      priceWire: { amountMinor: "1350", currency: "CNY" as const },
      stock: 159,
      imageUrl: null
    }],
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
        price: "captured" as const,
        stock: "captured" as const,
        skus: "captured" as const,
        weight: "source_absent" as const,
        dimensions: "source_absent" as const
      },
      expectedSkuCount: 1,
      capturedSkuCount: 1,
      acceptedMainImages: 1,
      acceptedDetailImages: 0,
      rejectedImages: 0,
      warnings: []
    }
  };
}

describe("background message bridge", () => {
  it("injects the structured-data bridge into the page main world", async () => {
    const executeScript = vi.fn(async () => []);

    await executePageContextBridge({ executeScript }, 42);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["page-context.js"],
      world: "MAIN"
    }, expect.any(Function));
  });

  it("captures detail pages before passing complete items to the local submitter", async () => {
    const capture = completeCapture();
    const submitBatch = vi.fn(async () => ({
      outcome: "submitted" as const,
      accepted: 1,
      items: [capture]
    }));
    const captureBatch = vi.fn(async () => ({
      batchId: "batch_abc",
      captures: [capture],
      failures: []
    }));
    const sendResponse = vi.fn();
    const handler = createBackgroundMessageHandler({
      submitter: { submitBatch, loadPausedBatch: async () => null },
      queue: { captureBatch }
    });
    const message = {
      kind: "submit-selected",
      batchId: "batch_abc",
      items: [{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html"
      }]
    };

    expect(handler(message, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(captureBatch).toHaveBeenCalledWith(
      { batchId: "batch_abc", items: message.items },
      expect.any(Function)
    );
    expect(submitBatch).toHaveBeenCalledWith({
      batchId: "batch_abc",
      items: [capture]
    });
  });

  it("captures and submits the current detail tab without opening or closing another tab", async () => {
    const capture = completeCapture();
    const captureCurrent = vi.fn(async () => capture);
    const submitBatch = vi.fn(async () => ({
      outcome: "submitted" as const,
      accepted: 1,
      products: [{
        sourceItemId: capture.sourceItemId,
        productId: "prod-1",
        revisionId: "rev-1",
        created: true
      }],
      rejected: [],
      items: [capture]
    }));
    const sendResponse = vi.fn();
    const handler = createBackgroundMessageHandler({
      submitter: {
        submitBatch,
        loadPausedBatch: async () => null,
        hasToken: async () => true
      },
      queue: { captureBatch: vi.fn() },
      captureCurrent
    });

    expect(handler({
      kind: "capture-current-detail",
      tabId: 42,
      batchId: "batch-current"
    }, sendResponse)).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(captureCurrent).toHaveBeenCalledWith(42);
    expect(submitBatch).toHaveBeenCalledWith({
      batchId: "batch-current",
      items: [capture]
    });
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "submitted",
      capture,
      products: [{ productId: "prod-1", revisionId: "rev-1", sourceItemId: capture.sourceItemId, created: true }]
    }));
  });

  it("returns a paused batch so refreshed content UI can recover", async () => {
    const paused = { batchId: "batch_saved", items: [] };
    const sendResponse = vi.fn();
    const handler = createBackgroundMessageHandler({
      submitter: { submitBatch: vi.fn(), loadPausedBatch: async () => paused },
      queue: { captureBatch: vi.fn() }
    });
    expect(handler({ kind: "get-paused-submission" }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(paused));
  });

  it("does not submit failed detail captures to the local API", async () => {
    const submitBatch = vi.fn();
    const failedItem = {
      sourceItemId: "892408514788",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      title: "测试商品"
    };
    const sendResponse = vi.fn();
    const handler = createBackgroundMessageHandler({
      submitter: { submitBatch, loadPausedBatch: async () => null },
      queue: {
        captureBatch: vi.fn(async () => ({
          batchId: "batch_abc",
          captures: [],
          failures: [{ item: failedItem, reason: "detail_images_missing" }]
        }))
      }
    });

    handler({
      kind: "submit-selected",
      batchId: "batch_abc",
      items: [failedItem]
    }, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(submitBatch).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "paused",
      reason: "capture_failed",
      failedItems: [failedItem],
      failureReasons: [{
        sourceItemId: "892408514788",
        reason: "detail_images_missing"
      }]
    }));
  });

  it("reports a missing token before opening detail tabs", async () => {
    const submitBatch = vi.fn();
    const captureBatch = vi.fn();
    const sendResponse = vi.fn();
    const handler = createBackgroundMessageHandler({
      submitter: {
        submitBatch,
        loadPausedBatch: async () => null,
        hasToken: async () => false
      },
      queue: { captureBatch }
    });

    expect(handler({
      kind: "submit-selected",
      batchId: "batch_abc",
      items: [{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html"
      }]
    }, sendResponse)).toBe(true);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
      outcome: "paused",
      reason: "missing_token",
      items: []
    }));
    expect(captureBatch).not.toHaveBeenCalled();
    expect(submitBatch).not.toHaveBeenCalled();
  });
});
