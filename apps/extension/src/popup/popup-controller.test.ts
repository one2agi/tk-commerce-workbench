// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  captureCurrentDetail,
  formatCaptureSummary,
  is1688DetailUrl
} from "./popup-controller.js";

describe("popup current-detail controller", () => {
  it("accepts only canonical 1688 offer detail pages", () => {
    expect(is1688DetailUrl("https://detail.1688.com/offer/1051175706079.html")).toBe(true);
    expect(is1688DetailUrl("https://s.1688.com/selloffer/offer_search.htm")).toBe(false);
    expect(is1688DetailUrl("https://example.com/offer/1051175706079.html")).toBe(false);
  });

  it("submits the active detail tab and preserves the current page", async () => {
    const sendMessage = vi.fn(async () => ({
      outcome: "submitted",
      accepted: 1,
      capture: {
        title: "专业制作棒球帽",
        sourcePriceRangeWire: {
          minAmountMinor: "1150",
          maxAmountMinor: "1280",
          currency: "CNY"
        },
        sourceStock: 300,
        skus: [{ skuId: "sku-1" }, { skuId: "sku-2" }],
        mainImages: ["main.jpg"],
        detailImages: ["detail.jpg"],
        captureQuality: "detail_page_complete",
        diagnostics: { warnings: [] }
      },
      products: [{
        sourceItemId: "1051175706079",
        productId: "prod-1",
        revisionId: "rev-1",
        created: true
      }],
      items: []
    }));

    const result = await captureCurrentDetail({
      tabId: 42,
      url: "https://detail.1688.com/offer/1051175706079.html",
      now: () => 123456,
      batchId: "detail-1051175706079-fixed",
      sendMessage
    });

    expect(sendMessage).toHaveBeenCalledWith({
      kind: "capture-current-detail",
      tabId: 42,
      batchId: "detail-1051175706079-fixed"
    });
    expect(result).toMatchObject({
      kind: "success",
      productId: "prod-1",
      summary: {
        title: "专业制作棒球帽",
        price: "¥11.50–12.80",
        stock: "300",
        skuCount: 2,
        mainImageCount: 1,
        detailImageCount: 1,
        quality: "完整"
      }
    });
  });

  it("shows explicit partial warnings instead of reporting full success", () => {
    expect(formatCaptureSummary({
      title: "部分商品",
      sourcePriceRangeWire: null,
      sourceStock: null,
      skus: [],
      mainImages: ["main.jpg"],
      detailImages: [],
      captureQuality: "detail_page_partial",
      diagnostics: {
        warnings: ["missing_source_price", "missing_sku"]
      }
    })).toEqual({
      title: "部分商品",
      price: "源页面未提供",
      stock: "源页面未提供",
      skuCount: 0,
      mainImageCount: 1,
      detailImageCount: 0,
      quality: "部分成功",
      warnings: ["价格采集不完整", "SKU采集不完整"]
    });
  });
});
