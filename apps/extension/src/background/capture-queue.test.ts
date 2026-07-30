// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createDetailCaptureQueue } from "./capture-queue.js";

function completeCapture(sourceItemId: string) {
  return {
    sourceItemId,
    sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html`,
    title: `商品 ${sourceItemId}`,
    mainImages: [`https://img.test/${sourceItemId}.jpg`],
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

describe("detail capture queue", () => {
  it("captures selected detail pages strictly one at a time", async () => {
    const trace: string[] = [];
    let nextTabId = 1;
    const port = {
      open: vi.fn(async (url: string) => {
        trace.push(`open:${url}`);
        return nextTabId++;
      }),
      waitUntilComplete: vi.fn(async (tabId: number) => {
        trace.push(`ready:${tabId}`);
      }),
      capture: vi.fn(async (tabId: number) => {
        trace.push(`capture:${tabId}`);
        const sourceItemId = tabId === 1 ? "892408514788" : "1013001591920";
        return completeCapture(sourceItemId);
      }),
      close: vi.fn(async (tabId: number) => {
        trace.push(`close:${tabId}`);
      })
    };
    const queue = createDetailCaptureQueue(port);

    const result = await queue.captureBatch({
      batchId: "batch-1",
      items: [
        {
          sourceItemId: "892408514788",
          sourceUrl: "https://detail.1688.com/offer/892408514788.html",
          title: "商品一"
        },
        {
          sourceItemId: "1013001591920",
          sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
          title: "商品二"
        }
      ]
    });

    expect(result.captures).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(trace).toEqual([
      "open:https://detail.1688.com/offer/892408514788.html",
      "ready:1",
      "capture:1",
      "close:1",
      "open:https://detail.1688.com/offer/1013001591920.html",
      "ready:2",
      "capture:2",
      "close:2"
    ]);
  });

  it("keeps failed items out of the API payload and reports retryable progress", async () => {
    const progress: Array<Record<string, unknown>> = [];
    const port = {
      open: vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
      waitUntilComplete: vi.fn(),
      capture: vi.fn()
        .mockRejectedValueOnce(new Error("detail_images_missing"))
        .mockResolvedValueOnce(completeCapture("1013001591920")),
      close: vi.fn()
    };
    const queue = createDetailCaptureQueue(port);
    const items = [
      {
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        title: "商品一"
      },
      {
        sourceItemId: "1013001591920",
        sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
        title: "商品二"
      }
    ];

    const result = await queue.captureBatch(
      { batchId: "batch-1", items },
      (event) => progress.push(event)
    );

    expect(result.captures.map((item) => item.sourceItemId)).toEqual(["1013001591920"]);
    expect(result.failures).toEqual([{
      item: items[0],
      reason: "detail_images_missing"
    }]);
    expect(progress.at(-1)).toMatchObject({
      state: "completed",
      total: 2,
      succeeded: 1,
      failed: 1
    });
  });
});
