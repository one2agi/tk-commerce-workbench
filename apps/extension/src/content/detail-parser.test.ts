// @vitest-environment node
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
let page: Awaited<ReturnType<typeof browser.newPage>>;
let parserScript = "";

const PRODUCT_HTML = `
  <main>
    <header>
      <h1>洛阳千易针织有限公司</h1>
      <img src="https://cbu01.alicdn.com/-55-tps-15-8.svg">
      <img src="https://cbu01.alicdn.com/164-32.png">
    </header>
    <section data-tk-product-hero>
      <h1 data-tk-product-title>不锈钢女士手表</h1>
      <div data-tk-main-gallery>
        <img src="https://cbu01.alicdn.com/img/ibank/main-1.jpg" width="800" height="800">
        <img data-src="https://cbu01.alicdn.com/img/ibank/main-2.jpg" width="800" height="800">
      </div>
    </section>
    <section data-tk-attributes>
      <dl><dt>品牌</dt><dd>Dishidu</dd></dl>
      <div data-tk-attribute><span>材质</span><span>不锈钢</span></div>
    </section>
    <section data-tk-detail>
      <p>女士轻奢石英表商品详情</p>
      <img data-lazy-src="//cbu01.alicdn.com/img/ibank/detail-1.jpg" width="790" height="1200">
    </section>
    <section data-tk-sku>
      <div data-tk-sku-group>
        <strong>颜色</strong>
        <button data-tk-sku-value>银色</button>
        <button data-tk-sku-value>金色</button>
      </div>
    </section>
  </main>
`;

beforeAll(async () => {
  const sourcePath = fileURLToPath(new URL("./detail-parser.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }).outputText
    .replace(/^export\s+/gmu, "")
    .replace(/^\{\};?\s*$/gmu, "");
  parserScript = `${compiled}
    window.TKParser = {
      parse1688DetailPage,
      captureStable1688DetailPage,
      createDetailCaptureMessageHandler
    };`;
  browser = await chromium.launch({
    headless: true,
    executablePath: "/snap/bin/chromium",
    args: ["--no-sandbox"]
  });
}, 20_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent(PRODUCT_HTML);
  await page.addScriptTag({ content: parserScript });
});

describe("parse1688DetailPage", () => {
  it("extracts product facts but marks DOM-only SKU groups partial instead of inventing rows", async () => {
    const capture = await page.evaluate(() => {
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(
            document: Document,
            url: string,
            date: Date,
            context: unknown
          ): unknown;
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/892408514788.html",
        new Date("2026-07-24T08:00:00.000Z"),
        {
          offerId: "892408514788",
          title: "不锈钢女士手表",
          supplierName: "洛阳千易针织有限公司",
          mainImages: [
            "https://cbu01.alicdn.com/img/ibank/main-1.jpg",
            "https://cbu01.alicdn.com/img/ibank/main-2.jpg"
          ],
          attributes: [
            { name: "品牌", value: "Dishidu" },
            { name: "材质", value: "不锈钢" }
          ]
        }
      );
    });

    expect(capture).toMatchObject({
      sourceItemId: "892408514788",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      title: "不锈钢女士手表",
      mainImages: [
        "https://cbu01.alicdn.com/img/ibank/main-1.jpg",
        "https://cbu01.alicdn.com/img/ibank/main-2.jpg"
      ],
      detailImages: ["https://cbu01.alicdn.com/img/ibank/detail-1.jpg"],
      descriptionText: "女士轻奢石英表商品详情",
      attributes: [
        { name: "品牌", value: "Dishidu" },
        { name: "材质", value: "不锈钢" }
      ],
      skuAttributes: [{
        name: "颜色",
        values: [{ name: "银色" }, { name: "金色" }]
      }],
      skuText: ["颜色: 银色 / 金色"],
      capturedAt: "2026-07-24T08:00:00.000Z",
      skus: [],
      captureQuality: "detail_page_partial",
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
          price: "source_absent",
          stock: "source_absent",
          skus: "capture_failed",
          weight: "source_absent",
          dimensions: "source_absent"
        },
        expectedSkuCount: null,
        capturedSkuCount: 0,
        acceptedMainImages: 2,
        acceptedDetailImages: 1,
        rejectedImages: 1,
        warnings: ["missing_sku"]
      }
    });
    expect(JSON.stringify(capture)).not.toContain("-55-tps-15-8.svg");
    expect(JSON.stringify(capture)).not.toContain("164-32.png");
  });

  it("captures visible 1688 Ant Design attributes and derives the item number", async () => {
    const capture = await page.evaluate(() => {
      document.querySelector("[data-tk-attributes]")?.remove();
      const root = document.createElement("section");
      root.className = "core-attributes";
      root.innerHTML = `
        <table><tbody>
          <tr class="ant-descriptions-row">
            <th class="ant-descriptions-item-label"><span>产品类别</span></th>
            <td class="ant-descriptions-item-content"><span class="field-value">棒球帽</span></td>
            <th class="ant-descriptions-item-label"><span>货号</span></th>
            <td class="ant-descriptions-item-content"><span class="field-value">1222232</span></td>
          </tr>
        </tbody></table>`;
      document.body.append(root);
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string, date: Date, context: unknown): {
            itemNumber: string | null;
            attributes: Array<{ name: string; value: string }>;
          };
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/1051175706079.html",
        new Date(),
        {
          offerId: "1051175706079",
          title: "专业制作棒球帽",
          supplierName: "测试工厂",
          mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
          attributes: [{ name: "品牌", value: "YUMSUPERMAN" }]
        }
      );
    });

    expect(capture.itemNumber).toBe("1222232");
    expect(capture.attributes).toEqual([
      { name: "品牌", value: "YUMSUPERMAN" },
      { name: "产品类别", value: "棒球帽" },
      { name: "货号", value: "1222232" }
    ]);
  });

  it("fails closed when the only candidate is page chrome", async () => {
    const message = await page.evaluate(() => {
      document.querySelector("[data-tk-product-hero]")!.innerHTML = `
        <h1 data-tk-product-title>不锈钢女士手表</h1>
        <div data-tk-main-gallery>
          <img src="https://cbu01.alicdn.com/-55-tps-15-8.svg" width="800" height="800">
        </div>`;
      const parser = (window as unknown as {
        TKParser: { parse1688DetailPage(document: Document, url: string): unknown };
      }).TKParser;
      try {
        parser.parse1688DetailPage(
          document,
          "https://detail.1688.com/offer/892408514788.html"
        );
        return "unexpected_success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    });

    expect(message).toBe("detail_main_images_missing");
  });

  it("rejects a supplier heading instead of treating it as a product title", async () => {
    const message = await page.evaluate(() => {
      document.querySelector("[data-tk-product-title]")?.remove();
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string, date: Date, context: unknown): unknown;
        };
      }).TKParser;
      try {
        parser.parse1688DetailPage(
          document,
          "https://detail.1688.com/offer/892408514788.html",
          new Date(),
          {
            offerId: "892408514788",
            title: "洛阳千易针织有限公司",
            supplierName: "洛阳千易针织有限公司",
            mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
            attributes: []
          }
        );
        return "unexpected_success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    });

    expect(message).toBe("detail_title_is_supplier");
  });

  it("uses product meta title when the 1688 DOM title class changes", async () => {
    const capture = await page.evaluate(() => {
      document.querySelector("[data-tk-product-title]")?.remove();
      document.querySelector(".od-title")?.remove();
      document.querySelector(".title-text")?.remove();
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:title");
      meta.setAttribute("content", "Dishidu迪时度手表女手链表精致小巧女士轻奢小众石英女表高颜值 - 阿里巴巴");
      document.head.appendChild(meta);
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string, date: Date, context: unknown): {
            title: string;
            diagnostics: { titleSource: string };
          };
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/892408514788.html",
        new Date(),
        {
          offerId: "892408514788",
          title: "",
          supplierName: "洛阳千易针织有限公司",
          mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
          attributes: []
        }
      );
    });

    expect(capture.title).toBe("Dishidu迪时度手表女手链表精致小巧女士轻奢小众石英女表高颜值");
    expect(capture.diagnostics.titleSource).toBe("product_heading");
  });

  it("uses a normalized document title for confirmed 1688 product pages", async () => {
    const capture = await page.evaluate(() => {
      document.querySelector("[data-tk-product-title]")?.remove();
      document.querySelectorAll("meta[property='og:title'], meta[name='twitter:title'], meta[name='title']")
        .forEach((element) => element.remove());
      document.title = "专业制作棒球帽印字刺绣成人儿童帽子 - 阿里巴巴";
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string): {
            title: string;
            diagnostics: { titleSource: string };
          };
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/723872595409.html"
      );
    });

    expect(capture.title).toBe("专业制作棒球帽印字刺绣成人儿童帽子");
    expect(capture.diagnostics.titleSource).toBe("document_title");
  });

  it("uses the product H1 for regression offer 772377252585 when runtime title is absent", async () => {
    const capture = await page.evaluate(() => {
      document.querySelector("[data-tk-product-title]")?.remove();
      document.querySelectorAll("meta[property='og:title'], meta[name='twitter:title'], meta[name='title']")
        .forEach((element) => element.remove());
      document.title = "1688";
      const heading = document.createElement("h1");
      heading.textContent = "夏季透气速干运动短裤男士宽松五分裤";
      document.querySelector("[data-tk-product-hero]")?.prepend(heading);
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string): {
            title: string;
            diagnostics: { titleSource: string };
          };
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/772377252585.html"
      );
    });

    expect(capture.title).toBe("夏季透气速干运动短裤男士宽松五分裤");
    expect(capture.diagnostics.titleSource).toBe("product_heading");
  });

  it("rejects login and verification pages even when stale product DOM remains", async () => {
    const message = await page.evaluate(() => {
      document.querySelector("[data-tk-product-title]")!.textContent = "密码登录";
      const parser = (window as unknown as {
        TKParser: { parse1688DetailPage(document: Document, url: string): unknown };
      }).TKParser;
      try {
        parser.parse1688DetailPage(
          document,
          "https://detail.1688.com/offer/772377252585.html"
        );
        return "unexpected_success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    });

    expect(message).toBe("detail_page_invalid");
  });

  it("marks visible price, stock and SKU modules partial when structured rows are unavailable", async () => {
    const capture = await page.evaluate(() => {
      const price = document.createElement("section");
      price.className = "module-od-main-price";
      price.textContent = "¥3.30";
      const sku = document.createElement("section");
      sku.className = "module-od-sku-selection";
      sku.innerHTML = `
        <div class="feature-item">
          <div class="feature-item-label"><h3>颜色</h3></div>
          <button class="sku-filter-button"><span class="label-name">黑色</span></button>
        </div>
        <span class="item-price-stock">库存999顶</span>`;
      document.body.append(price, sku);
      document.querySelector("[data-tk-sku]")?.remove();
      const parser = (window as unknown as {
        TKParser: {
          parse1688DetailPage(document: Document, url: string): {
            captureQuality: string;
            diagnostics: { fieldEvidence: Record<string, string> };
          };
        };
      }).TKParser;
      return parser.parse1688DetailPage(
        document,
        "https://detail.1688.com/offer/899280969913.html"
      );
    });

    expect(capture.captureQuality).toBe("detail_page_partial");
    expect(capture.diagnostics.fieldEvidence).toMatchObject({
      price: "capture_failed",
      stock: "capture_failed",
      skus: "capture_failed"
    });
  });

  it("waits until the product snapshot stays stable", async () => {
    const stableForMs = await page.evaluate(async () => {
      const parser = (window as unknown as {
        TKParser: {
          captureStable1688DetailPage(options: Record<string, unknown>): Promise<{
            diagnostics: { stableForMs: number };
          }>;
        };
      }).TKParser;
      let clock = 0;
      let delayCount = 0;
      const result = await parser.captureStable1688DetailPage({
        document,
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        stableForMs: 2000,
        pollIntervalMs: 1000,
        timeoutMs: 8000,
        now: () => clock,
        delay: async (milliseconds: number) => {
          clock += milliseconds;
          delayCount += 1;
          if (delayCount === 4) {
            document.querySelector("[data-tk-detail]")!.append(" 新增详情");
          }
        },
        readPageContext: async () => ({
          offerId: "892408514788",
          title: "不锈钢女士手表",
          supplierName: "洛阳千易针织有限公司",
          mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
          attributes: []
        })
      });
      return result.diagnostics.stableForMs;
    });

    expect(stableForMs).toBeGreaterThanOrEqual(2000);
  });

  it("does not keep waiting when only non-core detail text changes", async () => {
    const stableForMs = await page.evaluate(async () => {
      const parser = (window as unknown as {
        TKParser: {
          captureStable1688DetailPage(options: Record<string, unknown>): Promise<{
            diagnostics: { stableForMs: number };
          }>;
        };
      }).TKParser;
      let clock = 0;
      let delayCount = 0;
      const result = await parser.captureStable1688DetailPage({
        document,
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        stableForMs: 2000,
        pollIntervalMs: 1000,
        timeoutMs: 8000,
        now: () => clock,
        delay: async (milliseconds: number) => {
          clock += milliseconds;
          delayCount += 1;
          document.querySelector("[data-tk-detail]")!.append(` 动态文案${delayCount}`);
        },
        readPageContext: async () => ({
          offerId: "892408514788",
          title: "不锈钢女士手表",
          supplierName: "洛阳千易针织有限公司",
          mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
          attributes: []
        })
      });
      return result.diagnostics.stableForMs;
    });

    expect(stableForMs).toBeGreaterThanOrEqual(2000);
  });

  it("requires structured price, stock and SKU rows to stay stable", async () => {
    const contextReadCount = await page.evaluate(async () => {
      const parser = (window as unknown as {
        TKParser: {
          captureStable1688DetailPage(options: Record<string, unknown>): Promise<unknown>;
        };
      }).TKParser;
      let clock = 0;
      let delays = 0;
      let contextReads = 0;
      const context = (stock: number) => ({
        offerId: "892408514788",
        title: "不锈钢女士手表",
        supplierName: "洛阳千易针织有限公司",
        mainImages: ["https://cbu01.alicdn.com/img/ibank/main-1.jpg"],
        attributes: [],
        sourcePriceWire: { amountMinor: "1350", currency: "CNY" },
        sourcePriceRangeWire: {
          minAmountMinor: "1350",
          maxAmountMinor: "1350",
          currency: "CNY"
        },
        sourceStock: stock,
        skuAttributes: [{ name: "颜色", values: [{ name: "银色" }] }],
        saleAttributes: [{ name: "颜色", value: "银色" }],
        colors: ["银色"],
        sizes: [],
        skus: [{
          skuId: "sku-silver",
          attributes: { 颜色: "银色" },
          priceWire: { amountMinor: "1350", currency: "CNY" },
          stock,
          imageUrl: null
        }],
        expectedSkuCount: 1,
        fieldEvidence: {
          price: "captured",
          stock: "captured",
          skus: "captured",
          weight: "source_absent",
          dimensions: "source_absent"
        }
      });
      await parser.captureStable1688DetailPage({
        document,
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        stableForMs: 2000,
        pollIntervalMs: 1000,
        timeoutMs: 8000,
        now: () => clock,
        delay: async (milliseconds: number) => {
          clock += milliseconds;
          delays += 1;
        },
        readPageContext: async () => {
          contextReads += 1;
          return context(contextReads === 1 ? 100 : 200);
        }
      });
      return contextReads;
    });

    expect(contextReadCount).toBeGreaterThanOrEqual(4);
  });
});
