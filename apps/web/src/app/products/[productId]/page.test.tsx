import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { productId, productRevisionId } from "@tk/contracts/ids";

import { renderProductPage } from "./page";

// Extract the workbench CTA <a> element from the rendered HTML by its
// user-visible anchor text "商品工作台". Returns the first match.
function extractWorkbenchCta(html: string): { href: string; text: string } | null {
  const re = /<a\b[^>]*?>([^<]*商品工作台[^<]*)<\/a>/;
  const match = re.exec(html);
  if (!match) return null;
  const tag = match[0].slice(0, match[0].indexOf(">") + 1);
  const hrefMatch = /\bhref="([^"]*)"/.exec(tag);
  return {
    href: hrefMatch ? hrefMatch[1] : "",
    text: match[1].trim()
  };
}

describe("product detail page", () => {
  it("renders the real ProductWorkspace projection supplied by ProductService", async () => {
    const html = renderToStaticMarkup(await renderProductPage(
      Promise.resolve({ productId: "database-product" }),
      {
        get: async () => ({
          productId: productId("database-product"),
          revisionId: productRevisionId("database-revision"),
          draftVersion: 7,
          originalListing: {
            sourceTitle: "数据库源标题",
            description: "源描述",
            sourceAttributes: [],
            saleAttributes: [],
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
          pricing: null,
          template: null,
          canvas: { runId: "canvas-real", outputs: ["https://images.test/generated.png"], state: "partial" },
          finalAssetOrder: [],
          warningCodes: ["canvas_partial"]
        })
      }
    ));

    expect(html).toContain("数据库源标题");
    expect(html).toContain("ชื่อจากฐานข้อมูล");
    expect(html).toContain("database-revision");
    expect(html).toContain("partial");
    expect(html).not.toContain("fixtures");
  });

  it("explains that processing happens on the workbench (商品工作台) via a CTA link and 'Canvas 生图' copy", async () => {
    const html = renderToStaticMarkup(await renderProductPage(
      Promise.resolve({ productId: "database-product" }),
      {
        get: async () => ({
          productId: productId("database-product"),
          revisionId: productRevisionId("database-revision"),
          draftVersion: 7,
          originalListing: {
            sourceTitle: "数据库源标题",
            description: "源描述",
            sourceAttributes: [],
            saleAttributes: [],
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
          pricing: null,
          template: null,
          canvas: { runId: "canvas-real", outputs: ["https://images.test/generated.png"], state: "partial" },
          finalAssetOrder: [],
          warningCodes: ["canvas_partial"]
        })
      }
    ));

    // Resolve the CTA anchored on the workbench anchor text — must be the SAME <a>
    // element that both names the workbench and points to "/".
    const cta = extractWorkbenchCta(html);
    expect(cta, "expected a <a> element wrapping the '商品工作台' text").not.toBeNull();
    expect(cta!.href).toBe("/");
    expect(cta!.text).toContain("商品工作台");

    // Copy mentions 'Canvas 生图' so users know processing is elsewhere
    expect(html).toContain("Canvas 生图");
    expect(html).toContain("开始处理");
  });
});
