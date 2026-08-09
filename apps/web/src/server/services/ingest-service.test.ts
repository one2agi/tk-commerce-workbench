import { describe, expect, it, vi } from "vitest";

import { IngestService } from "./ingest-service";

describe("IngestService link ingest", () => {
  it("uses the saved retry limit for newly queued jobs", async () => {
    const jobs = { enqueue: vi.fn(async () => "job-1") };
    const service = new IngestService(jobs, undefined, async () => ({ maxAttempts: 7 }));

    await service.ingest({
      version: 1,
      batchId: "batch-1",
      items: [{
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        idempotencyKey: "1688:892408514788:batch-1"
      }]
    });

    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 7 }));
  });
});

const capture = {
  sourceItemId: "892408514788",
  sourceUrl: "https://detail.1688.com/offer/892408514788.html",
  title: "测试商品",
  mainImages: ["https://cbu01.alicdn.com/img/ibank/main.jpg"],
  detailImages: ["https://cbu01.alicdn.com/img/ibank/detail.jpg"],
  descriptionText: "商品详情正文",
  itemNumber: "ITEM-001",
  category: "厨房用品",
  sourcePriceWire: { amountMinor: "1350", currency: "CNY" as const },
  sourcePriceRangeWire: {
    minAmountMinor: "1350",
    maxAmountMinor: "1450",
    currency: "CNY" as const
  },
  sourceStock: 159,
  weightKg: "0.2",
  dimensionsCm: { lengthCm: "24", widthCm: "18", heightCm: "15" },
  attributes: [{ name: "材质", value: "不锈钢" }],
  saleAttributes: [{ name: "颜色", value: "银色" }],
  skuAttributes: [{ name: "颜色", values: [{ name: "银色" }] }],
  skuText: ["颜色: 银色"],
  colors: ["银色"],
  sizes: [],
  skus: [{
    skuId: "sku-silver",
    attributes: { 颜色: "银色" },
    priceWire: { amountMinor: "1350", currency: "CNY" as const },
    stock: 159,
    imageUrl: null
  }],
  capturedAt: "2026-07-24T08:00:00.000Z",
  captureQuality: "detail_page_complete" as const,
  diagnostics: {
    version: 2 as const,
    pageKind: "offer_detail" as const,
    titleSource: "page_context" as const,
    stableForMs: 2000,
    fieldEvidence: {
      title: "captured" as const,
      mainImages: "captured" as const,
      detail: "captured" as const,
      attributes: "captured" as const,
      price: "captured" as const,
      stock: "captured" as const,
      skus: "captured" as const,
      weight: "captured" as const,
      dimensions: "captured" as const
    },
    expectedSkuCount: 1,
    capturedSkuCount: 1,
    acceptedMainImages: 1,
    acceptedDetailImages: 1,
    rejectedImages: 0,
    warnings: []
  },
  idempotencyKey: "1688:892408514788:batch_local_01"
};

describe("IngestService local detail capture", () => {
  it("persists a complete capture directly without enqueuing Miaoshou collection", async () => {
    const jobs = { enqueue: vi.fn() };
    const captures = {
      save: vi.fn(async () => ({
        sourceItemId: capture.sourceItemId,
        productId: "prod-1",
        revisionId: "rev-1",
        created: true
      }))
    };
    const service = new IngestService(jobs, captures);

    const result = await service.ingestLocal({
      version: 3,
      batchId: "batch_local_01",
      items: [capture]
    });

    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(captures.save).toHaveBeenCalledWith({
      batchId: "batch_local_01",
      item: capture
    });
    expect(result).toEqual({
      accepted: 1,
      products: [{
        sourceItemId: capture.sourceItemId,
        productId: "prod-1",
        revisionId: "rev-1",
        created: true
      }],
      rejected: []
    });
  });

  it("rejects only the item that cannot be persisted", async () => {
    const captures = {
      save: vi.fn()
        .mockResolvedValueOnce({
          sourceItemId: capture.sourceItemId,
          productId: "prod-1",
          revisionId: "rev-1",
          created: false
        })
        .mockRejectedValueOnce(new Error("database unavailable"))
    };
    const service = new IngestService({ enqueue: vi.fn() }, captures);
    const second = {
      ...capture,
      sourceItemId: "1013001591920",
      sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
      idempotencyKey: "1688:1013001591920:batch_local_01"
    };

    const result = await service.ingestLocal({
      version: 3,
      batchId: "batch_local_01",
      items: [capture, second]
    });

    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{
      sourceItemId: second.sourceItemId,
      sourceUrl: second.sourceUrl,
      reason: "persist_failed"
    }]);
  });
});
