import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assetId, productId, productRevisionId, templateId } from "@tk/contracts/ids";
import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

import { renderProductPage } from "./page";

const workspace: ProductWorkspaceV1 = {
  productId: productId("database-product"),
  revisionId: productRevisionId("database-revision"),
  draftVersion: 7,
  originalListing: {
    sourceTitle: "数据库源标题",
    description: "源描述",
    sourceAttributes: [{ name: "材质", value: "合金" }],
    saleAttributes: [{ name: "颜色", value: "金色" }],
    mainImages: ["https://images.test/source.png"],
    detailImages: []
  },
  target: {
    locale: "th-TH",
    title: "ชื่อจากฐานข้อมูล",
    description: "รายละเอียด",
    style: "clean",
    provider: "rule",
    model: "deterministic",
    fallbackUsed: false
  },
  pricing: {
    pricingRunId: "pricing-1",
    currency: "THB",
    finalPriceWire: { amountMinor: "29900", currency: "THB" },
    breakdown: { margin: "30%" },
    exchangeRate: null
  },
  template: {
    templateId: templateId("template-1"),
    version: 1,
    matchedReason: "TK工作流"
  },
  canvas: {
    runId: "canvas-real",
    outputs: ["https://images.test/generated.png"],
    state: "succeeded"
  },
  finalAssetOrder: [assetId("asset-1")],
  warningCodes: []
};

describe("product detail page", () => {
  it("renders the product detail image confirmation workspace", async () => {
    const html = renderToStaticMarkup(await renderProductPage(
      Promise.resolve({ productId: "database-product" }),
      {
        get: async () => workspace,
        preview: async () => ({
          productId: workspace.productId,
          draftVersion: workspace.draftVersion,
          listingRunId: "listing-1",
          pricingRunId: "pricing-1",
          templateVersion: 1,
          orderedFinalAssetIds: workspace.finalAssetOrder,
          locale: "th-TH",
          currency: "THB",
          finalPriceWire: { amountMinor: "29900", currency: "THB" },
          warningCodes: [],
          miaoshouTargetDetailId: "detail-1" as never,
          miaoshouWriteback: {
            state: "not_started", failureCode: null, safeMessage: null,
            retryAllowed: false, approvalSnapshotId: null
          }
        }),
        facts: async () => ({
          skuCount: 2,
          orderedFinalImages: [{ assetId: "asset-1", previewUrl: "https://images.test/final.jpg" }],
          stock: "10",
          weightKg: "0.50",
          dimensions: null,
          canonicalMiaoshouTarget: "detail-1"
        })
      }
    ));

    expect(html).toContain("商品详情 / 图片确认");
    expect(html).toContain("图片确认");
    expect(html).toContain("图片已生成");
    expect(html).toContain("商品内容");
    expect(html).toContain("下一步");
    expect(html).toContain("确认后写入妙手采集箱");
    expect(html).toContain("AI生成信息");
    expect(html).toContain("SKU确认");
    expect(html).toContain("检查结果");
    expect(html).toContain("检查通过");
    expect(html).toContain("确认写回妙手");
    expect(html).toContain("ชื่อจากฐานข้อมูล");
    expect(html).toContain("https://images.test/final.jpg");
    expect(html).not.toContain("请回到");
    expect(html).not.toContain("发布 TikTok");
  });
});
