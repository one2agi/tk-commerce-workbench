import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { productId, productRevisionId } from "@tk/contracts/ids";

import { renderProductPage } from "./page";

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
});
