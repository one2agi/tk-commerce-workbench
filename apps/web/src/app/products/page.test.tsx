import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { miaoshouDetailId, productId, productRevisionId, sourceItemId } from "@tk/contracts/ids";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { renderProductsPage } from "./page";

function item(overrides: Partial<ProductPoolItemV1> = {}): ProductPoolItemV1 {
  return {
    productId: productId("database-product-a"),
    currentRevisionId: productRevisionId("rev-a"),
    sourceItemId: sourceItemId("source-a"),
    sourceUrl: "https://detail.1688.com/offer/database-product-a.html",
    thumbnailUrl: "https://img.test/database-product-a.jpg",
    collectedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:10:00.000Z",
    canonicalSourceTitle: "数据库源标题 A",
    targetTitle: "目标标题 A",
    canonicalSuccessDetailId: miaoshouDetailId("detail-a"),
    locale: "th-TH",
    currency: "THB",
    priceWire: { amountMinor: "25900", currency: "THB" },
    sourceImageCount: 5,
    sourceCaptureQuality: null,
    imageCount: 3,
    usableCanvasOutputCount: 2,
    miaoshouSource: "success",
    automation: "running",
    assetArchive: "ready",
    listing: "ready",
    canvas: "succeeded",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: [],
    ...overrides
  };
}

describe("products route", () => {
  it("renders the same product workbench as the primary product entry", () => {
    const html = renderToStaticMarkup(renderProductsPage({ items: [item()] }));

    expect(html).toContain("aria-label=\"商品工作台\"");
    expect(html).toContain("全部（1）");
    expect(html).toContain("待确认（1）");
    expect(html).toContain("目标标题 A");
    expect(html).toContain("查看并确认");
    expect(html).not.toContain("Catalog");
    expect(html).not.toContain("商品列表");
    expect(html).not.toContain("源标题");
  });
});
