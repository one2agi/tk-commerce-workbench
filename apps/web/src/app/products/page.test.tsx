/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { productId, productRevisionId } from "@tk/contracts/ids";

import { renderProductsPage } from "./page";

describe("product list page", () => {
  it("renders the real ProductPoolItemV1 projection supplied by ProductService.list()", () => {
    const html = renderToStaticMarkup(renderProductsPage(
      { items: [
        {
          productId: productId("database-product-a"),
          currentRevisionId: productRevisionId("rev-a"),
          sourceItemId: null,
          canonicalSourceTitle: "数据库源标题 A",
          targetTitle: "目标标题 A",
          canonicalSuccessDetailId: null,
          locale: "th-TH",
          currency: "THB",
          priceWire: { amountMinor: "25900", currency: "THB" },
          imageCount: 3,
          usableCanvasOutputCount: 2,
          miaoshouSource: "submitted",
          automation: "running",
          assetArchive: "ready",
          listing: "ready",
          canvas: "succeeded",
          approval: "unapproved",
          miaoshouEdit: "not_started",
          warningCodes: ["missing_price"]
        },
        {
          productId: productId("database-product-b"),
          currentRevisionId: productRevisionId("rev-b"),
          sourceItemId: null,
          canonicalSourceTitle: null,
          targetTitle: null,
          canonicalSuccessDetailId: null,
          locale: "th-TH",
          currency: "THB",
          priceWire: null,
          imageCount: 0,
          usableCanvasOutputCount: 0,
          miaoshouSource: "not_started",
          automation: "not_started",
          assetArchive: "pending",
          listing: "pending",
          canvas: "not_started",
          approval: "unapproved",
          miaoshouEdit: "not_started",
          warningCodes: []
        }
      ] }
    ));

    // Page heading & count
    expect(html).toContain("商品列表");
    expect(html).toContain("2 个商品");

    // Row 1 — full data
    expect(html).toContain("database-product-a");
    expect(html).toContain("数据库源标题 A");
    expect(html).toContain("目标标题 A");
    expect(html).toContain("unapproved");
    expect(html).toContain("missing_price");
    expect(html).toContain("/products/database-product-a");

    // Row 2 — empty data shows graceful fallback
    expect(html).toContain("database-product-b");
    expect(html).toContain("—");
  });

  it("renders an empty state that keeps the table skeleton (no log-style alert)", () => {
    const html = renderToStaticMarkup(renderProductsPage({ items: [] }));
    const normalized = html.toLowerCase();
    // Page heading still present
    expect(html).toContain("商品列表");
    expect(html).toContain("0 个商品");

    // Thead is ALWAYS rendered — table skeleton should remain even when empty.
    expect(html).toContain("<th");
    expect(html).toContain("源标题");
    expect(html).toContain("目标标题");

    // Empty row uses colspan and gentle copy, not a log/alert sentence.
    expect(html).toContain("tk-product-list-table__empty");
    expect(normalized).toContain('colspan="7"');
    expect(html).toContain("暂无商品");
    expect(html).toContain("商品工作台");
    expect(html).toContain('href="/"');

    // It does NOT look like the old log-style alert.
    expect(html).not.toContain("还没有商品");
  });
});
