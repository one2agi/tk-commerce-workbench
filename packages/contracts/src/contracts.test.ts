import { describe, expect, it } from "vitest";
import {
  ConfirmMiaoshouEditV1,
  IngestLinksV1,
  IngestLocalCapturesV2,
  IngestLocalCapturesV3,
  StartAutomationV1
} from "./commands.js";
import { JOB_KIND_VERSION, type MiaoshouCollectPayloadV1 } from "./jobs.js";

describe("command contracts", () => {
  it("accepts selected 1688 links only", () => {
    const result = IngestLinksV1.safeParse({
      version: 1,
      batchId: "batch_01",
      items: [
        {
          sourceUrl: "https://detail.1688.com/offer/892408514788.html",
          idempotencyKey: "1688:892408514788:batch_01"
        }
      ]
    });
    expect(result.success).toBe(true);
  });

  it("accepts validated local detail captures and rejects polluted products", () => {
    const complete = {
      version: 2,
      batchId: "batch_local_01",
      items: [{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        title: "测试商品",
        mainImages: ["https://cbu01.alicdn.com/img/ibank/main.jpg"],
        detailImages: [],
        descriptionText: "商品详情正文",
        attributes: [{ name: "材质", value: "不锈钢" }],
        skuAttributes: [{
          name: "颜色",
          values: [{ name: "银色", imageUrl: "https://cbu01.alicdn.com/img/ibank/silver.jpg" }]
        }],
        skuText: ["颜色: 银色"],
        capturedAt: "2026-07-24T08:00:00.000Z",
        captureQuality: "detail_page_validated",
        diagnostics: {
          version: 1,
          pageKind: "offer_detail",
          titleSource: "page_context",
          stableForMs: 2000,
          detailSection: "captured",
          attributesSection: "captured",
          skuSection: "captured",
          acceptedMainImages: 1,
          acceptedDetailImages: 0,
          rejectedImages: 4
        },
        idempotencyKey: "1688:892408514788:batch_local_01"
      }]
    };

    expect(IngestLocalCapturesV2.safeParse(complete).success).toBe(true);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{ ...complete.items[0], mainImages: [], detailImages: [] }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{ ...complete.items[0], sourceUrl: "https://example.com/product/1" }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{
        ...complete.items[0],
        sourceUrl: "https://detail.1688.com/offer/1013001591920.html"
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{
        ...complete.items[0],
        mainImages: ["https://cbu01.alicdn.com/img/icon.svg"]
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{
        ...complete.items[0],
        mainImages: ["https://cbu01.alicdn.com/164-32.png"]
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{
        ...complete.items[0],
        title: "登录页面"
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV2.safeParse({
      ...complete,
      items: [{
        ...complete.items[0],
        mainImages: ["https://img.alicdn.com/imgextra/i1/O1CN01Ckhvrm1wOznc4H2Dg_!!6000000006299-2-tps-87-32.png"]
      }]
    }).success).toBe(false);
  });

  it("accepts complete V3 captures with source price, stock and concrete SKU rows", () => {
    const complete = {
      version: 3,
      batchId: "batch_local_v3",
      items: [{
        sourceItemId: "1051175706079",
        sourceUrl: "https://detail.1688.com/offer/1051175706079.html",
        title: "多颜色多尺码商品",
        mainImages: ["https://cbu01.alicdn.com/img/ibank/main-v3.jpg"],
        detailImages: ["https://cbu01.alicdn.com/img/ibank/detail-v3.jpg"],
        descriptionText: "商品详情",
        itemNumber: "ITEM-1051175706079",
        category: "服饰 > 上衣",
        sourcePriceWire: { amountMinor: "1150", currency: "CNY" },
        sourcePriceRangeWire: {
          minAmountMinor: "1150",
          maxAmountMinor: "1280",
          currency: "CNY"
        },
        sourceStock: 26640,
        weightKg: null,
        dimensionsCm: null,
        attributes: [{ name: "材质", value: "棉" }],
        saleAttributes: [{ name: "颜色", value: "黑色" }],
        skuAttributes: [{
          name: "颜色",
          values: [{ name: "黑色", imageUrl: "https://cbu01.alicdn.com/img/ibank/black.jpg" }]
        }, {
          name: "尺码",
          values: [{ name: "M" }, { name: "L" }]
        }],
        colors: ["黑色"],
        sizes: ["M", "L"],
        skus: [{
          skuId: "sku-black-m",
          attributes: { 颜色: "黑色", 尺码: "M" },
          priceWire: { amountMinor: "1150", currency: "CNY" },
          stock: 100,
          imageUrl: "https://cbu01.alicdn.com/img/ibank/black.jpg",
          weightKg: "0.08",
          dimensionsCm: { lengthCm: "40", widthCm: "10", heightCm: "2" }
        }, {
          skuId: "sku-black-l",
          attributes: { 颜色: "黑色", 尺码: "L" },
          priceWire: { amountMinor: "1280", currency: "CNY" },
          stock: 200,
          imageUrl: null,
          weightKg: "0.09",
          dimensionsCm: { lengthCm: "45", widthCm: "10", heightCm: "2" }
        }],
        capturedAt: "2026-07-26T08:00:00.000Z",
        captureQuality: "detail_page_complete",
        diagnostics: {
          version: 2,
          pageKind: "offer_detail",
          titleSource: "page_context",
          stableForMs: 2000,
          fieldEvidence: {
            title: "captured",
            mainImages: "captured",
            detail: "captured",
            attributes: "captured",
            price: "captured",
            stock: "captured",
            skus: "captured",
            weight: "source_absent",
            dimensions: "captured"
          },
          expectedSkuCount: 2,
          capturedSkuCount: 2,
          acceptedMainImages: 1,
          acceptedDetailImages: 1,
          rejectedImages: 0,
          warnings: []
        },
        idempotencyKey: "1688:1051175706079:batch_local_v3"
      }]
    };
    const completeItem = complete.items[0]!;

    const parsedComplete = IngestLocalCapturesV3.safeParse(complete);
    expect(parsedComplete.success).toBe(true);
    expect(parsedComplete.success && parsedComplete.data.items[0]?.skus.map((sku) => sku.dimensionsCm))
      .toEqual([
        { lengthCm: "40", widthCm: "10", heightCm: "2" },
        { lengthCm: "45", widthCm: "10", heightCm: "2" }
      ]);
    expect(IngestLocalCapturesV3.safeParse({
      ...complete,
      items: [{
        ...completeItem,
        diagnostics: {
          ...completeItem.diagnostics,
          expectedSkuCount: 40
        }
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV3.safeParse({
      ...complete,
      items: [{
        ...completeItem,
        captureQuality: "detail_page_complete",
        diagnostics: {
          ...completeItem.diagnostics,
          fieldEvidence: {
            ...completeItem.diagnostics.fieldEvidence,
            stock: "capture_failed"
          },
          warnings: ["missing_source_stock"]
        }
      }]
    }).success).toBe(false);
    expect(IngestLocalCapturesV3.safeParse({
      ...complete,
      items: [{
        ...completeItem,
        skus: completeItem.skus.map((sku, index) => ({
          ...sku,
          ...(index === 0 ? { weightKg: "-0.08" } : {})
        }))
      }]
    }).success).toBe(false);
  });

  it("keeps the Miaoshou collection job at the ingest-before-product boundary", () => {
    const payload = {
      version: 1,
      batchId: "batch_01",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: "1688:892408514788:batch_01"
    } satisfies MiaoshouCollectPayloadV1;

    expect(payload.batchId).toBe("batch_01");
    expect(payload).not.toHaveProperty("revisionId");
  });

  it("versions every persisted internal ready-preview DAG job kind", () => {
    expect(JOB_KIND_VERSION).toMatchObject({ template_match: 1, image_select: 1, final_preview: 1, staging_cleanup: 1 });
  });

  it("requires explicit commands for processing and Miaoshou edit", () => {
    const start = StartAutomationV1.parse({ version: 1, revisionIds: ["rev_01"] });
    expect(start.revisionIds).toHaveLength(1);

    const confirm = ConfirmMiaoshouEditV1.parse({
      version: 1,
      productId: "product_01",
      expectedDraftVersion: 3,
      expectedListingRunId: "listing_run_01",
      expectedTemplateVersion: 2,
      orderedFinalAssetIds: ["asset_01", "asset_02"]
    });
    expect(confirm.expectedDraftVersion).toBe(3);
    expect(confirm).not.toHaveProperty("expectedPricingRunId");
    expect(confirm.orderedFinalAssetIds).toHaveLength(2);
  });
});
