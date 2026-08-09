// @vitest-environment node
import { describe, expect, it } from "vitest";
// @ts-expect-error The workspace provides jsdom at runtime without package-local typings.
import { JSDOM } from "jsdom";

import { requestPageContext } from "./detail-parser.js";
import {
  installPageContextBridge,
  read1688PageContext
} from "./page-context-bridge.js";

describe("read1688PageContext", () => {
  it("transfers the allowlisted snapshot across the shared DOM event mailbox", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://detail.1688.com/offer/1051175706079.html"
    });
    const pageWindow = dom.window as unknown as Window & {
      context: unknown;
    };
    pageWindow.context = {
      result: {
        data: {
          productTitle: { fields: { title: "DOM邮箱测试商品" } },
          gallery: {
            fields: {
              offerId: 1051175706079,
              mainImage: ["https://cbu01.alicdn.com/img/ibank/mailbox.jpg"]
            }
          },
          secretToken: "must-not-cross"
        }
      }
    };
    const uninstall = installPageContextBridge(pageWindow);
    const snapshot = await requestPageContext(pageWindow, 100);

    expect(snapshot).toMatchObject({
      offerId: "1051175706079",
      title: "DOM邮箱测试商品",
      mainImages: ["https://cbu01.alicdn.com/img/ibank/mailbox.jpg"]
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cross");
    uninstall();
    dom.window.close();
  });

  it("returns only allowlisted product fields from the 1688 page context", () => {
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: {
              fields: {
                title: "女士轻奢石英表",
                shopInfo: { companyName: "洛阳千易针织有限公司" }
              }
            },
            gallery: {
              fields: {
                offerId: 892408514788,
                mainImage: [
                  { fullPathImageURI: "https://cbu01.alicdn.com/img/ibank/main-1.jpg" },
                  { imageURI: "img/ibank/main-2.jpg" }
                ]
              }
            },
            globalData: {
              model: {
                offerDetail: {
                  featureAttributes: [
                    { name: "材质", value: "不锈钢" },
                    { name: "风格", values: ["轻奢", "小众"] }
                  ]
                }
              }
            },
            secretToken: "must-not-leak"
          }
        }
      }
    });

    expect(snapshot).toMatchObject({
      offerId: "892408514788",
      title: "女士轻奢石英表",
      supplierName: "洛阳千易针织有限公司",
      mainImages: [
        "https://cbu01.alicdn.com/img/ibank/main-1.jpg",
        "https://cbu01.alicdn.com/img/ibank/main-2.jpg"
      ],
      attributes: [
        { name: "材质", value: "不锈钢" },
        { name: "风格", value: "轻奢,小众" }
      ]
    });
    expect(snapshot).not.toHaveProperty("secretToken");
  });

  it("returns null until the product context is ready", () => {
    expect(read1688PageContext({ context: { result: { data: {} } } })).toBeNull();
  });

  it("accepts page context modules whose values are not wrapped in fields", () => {
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: {
              title: "免 fields 包装的商品标题",
              shopInfo: { companyName: "供应商名称" }
            },
            gallery: {
              offerId: "1013001591920",
              mainImage: ["//cbu01.alicdn.com/img/ibank/direct-main.jpg"]
            }
          }
        }
      }
    });

    expect(snapshot).toMatchObject({
      offerId: "1013001591920",
      title: "免 fields 包装的商品标题",
      supplierName: "供应商名称",
      mainImages: ["https://cbu01.alicdn.com/img/ibank/direct-main.jpg"]
    });
  });

  it("does not loop forever when the page context contains cyclic objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: { fields: { title: "测试商品" } },
            gallery: {
              fields: {
                offerId: "892408514788",
                mainImage: ["https://cbu01.alicdn.com/img/ibank/main.jpg"]
              }
            },
            cyclic
          }
        }
      }
    });

    expect(snapshot?.title).toBe("测试商品");
  });

  it("extracts the concrete 1688 SKU map with price, stock, images and package facts", () => {
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: {
              fields: {
                title: "专业制作棒球帽",
                shopInfo: { companyName: "测试供应商" }
              }
            },
            gallery: {
              fields: {
                offerId: 1051175706079,
                mainImage: ["https://cbu01.alicdn.com/img/ibank/cap-main.jpg"]
              }
            },
            mainPrice: {
              fields: {
                finalPriceModel: {
                  tradeWithoutPromotion: {
                    offerMinPrice: "11.50",
                    offerMaxPrice: "12.80",
                    canBookedAmountOriginal: 300
                  }
                }
              }
            },
            Root: {
              fields: {
                dataJson: {
                  isSkuOffer: true,
                  isPricePrivate: false,
                  offerModelSign: { isSupportStock: true },
                  orderParamModel: {
                    orderParam: { canBookedAmount: 300 }
                  },
                  skuModel: {
                    skuProps: [{
                      prop: "颜色",
                      value: [{
                        name: "白色",
                        imageUrl: "https://cbu01.alicdn.com/img/ibank/cap-white.jpg"
                      }]
                    }, {
                      prop: "尺码",
                      value: [{ name: "S" }, { name: "M" }]
                    }],
                    skuInfoMap: {
                      "白色&gt;S": {
                        specId: "spec-white-s",
                        specAttrs: "白色&gt;S",
                        price: "11.50",
                        canBookCount: 100,
                        skuId: 6085672573177
                      },
                      "白色&gt;M": {
                        specId: "spec-white-m",
                        specAttrs: "白色&gt;M",
                        discountPrice: "12.80",
                        canBookCount: 200,
                        skuId: 6085672573178
                      }
                    }
                  }
                }
              }
            },
            productPackInfo: {
              fields: {
                pieceWeightScale: {
                  pieceWeightScaleInfo: [{
                    sku1: "白色",
                    sku2: "S",
                    length: 24,
                    width: 18,
                    height: 15,
                    weight: 200,
                    skuId: 6085672573177
                  }, {
                    sku1: "白色",
                    sku2: "M",
                    length: 24,
                    width: 18,
                    height: 15,
                    weight: 200,
                    skuId: 6085672573178
                  }]
                }
              }
            },
            secretToken: "must-not-leak"
          }
        }
      }
    });

    expect(snapshot).toMatchObject({
      sourcePriceWire: { amountMinor: "1150", currency: "CNY" },
      sourcePriceRangeWire: {
        minAmountMinor: "1150",
        maxAmountMinor: "1280",
        currency: "CNY"
      },
      sourceStock: 300,
      weightKg: "0.2",
      dimensionsCm: { lengthCm: "24", widthCm: "18", heightCm: "15" },
      skuAttributes: [{
        name: "颜色",
        values: [{
          name: "白色",
          imageUrl: "https://cbu01.alicdn.com/img/ibank/cap-white.jpg"
        }]
      }, {
        name: "尺码",
        values: [{ name: "S" }, { name: "M" }]
      }],
      colors: ["白色"],
      sizes: ["S", "M"],
      expectedSkuCount: 2,
      skus: [{
        skuId: "6085672573177",
        attributes: { 颜色: "白色", 尺码: "S" },
        priceWire: { amountMinor: "1150", currency: "CNY" },
        stock: 100,
        imageUrl: "https://cbu01.alicdn.com/img/ibank/cap-white.jpg"
      }, {
        skuId: "6085672573178",
        attributes: { 颜色: "白色", 尺码: "M" },
        priceWire: { amountMinor: "1280", currency: "CNY" },
        stock: 200,
        imageUrl: "https://cbu01.alicdn.com/img/ibank/cap-white.jpg"
      }],
      fieldEvidence: {
        price: "captured",
        stock: "captured",
        skus: "captured",
        weight: "captured",
        dimensions: "captured"
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-leak");
  });

  it("treats truly absent package dimensions as source-absent instead of a parser failure", () => {
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: { fields: { title: "无包装尺寸商品" } },
            gallery: {
              fields: {
                offerId: 772377252585,
                mainImage: ["https://cbu01.alicdn.com/img/ibank/no-dimensions.jpg"]
              }
            },
            productPackInfo: {
              fields: {
                pieceWeightScale: {
                  pieceWeightScaleInfo: [
                    { skuId: 1, weight: 25 },
                    { skuId: 2, weight: 25 }
                  ]
                }
              }
            }
          }
        }
      }
    });

    expect(snapshot).toMatchObject({
      weightKg: "0.025",
      dimensionsCm: null,
      fieldEvidence: {
        weight: "captured",
        dimensions: "source_absent"
      }
    });
  });

  it("keeps mixed 1688 package weights on their concrete SKUs instead of discarding the table", () => {
    const packageRows = [
      { sku1: "蕾丝花边草帽-米色", weight: 80, skuId: 6031984132315 },
      { sku1: "蕾丝花边草帽-卡其", weight: 80, skuId: 6031984132316 },
      { sku1: "出游草帽-米色", weight: 80, skuId: 6031984132317 },
      { sku1: "出游草帽-卡其", weight: 80, skuId: 6031984132318 },
      { sku1: "蕾丝草编-米色", weight: 80, skuId: 6031984132319 },
      { sku1: "蕾丝珍珠草帽-米色", weight: 80, skuId: 6077392716632 },
      { sku1: "蕾丝珍珠草帽-卡其色", weight: 80, skuId: 6077392716633 },
      { sku1: "碎花弯檐草帽-卡其色", weight: 80, skuId: 6077392716638 },
      { sku1: "绿白花蕾丝草帽-米色", weight: 80, skuId: 6077392716636 },
      { sku1: "绿白花蕾丝草帽-卡其色", weight: 80, skuId: 6077392716639 },
      { sku1: "紫色花蕾丝草帽-卡色", weight: 80, skuId: 6077392716640 },
      { sku1: "碎花弯檐草帽-卡其", weight: 80, skuId: 6117184393647 },
      { sku1: "防风绳一根-单拍不发", weight: 10, skuId: 6031984132321 }
    ];
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: { fields: { title: "法式蕾丝蝴蝶结草帽" } },
            gallery: {
              fields: {
                offerId: 1022498388851,
                mainImage: ["https://cbu01.alicdn.com/img/ibank/mixed-weight.jpg"]
              }
            },
            Root: {
              fields: {
                dataJson: {
                  isSkuOffer: true,
                  skuModel: {
                    skuProps: [{
                      prop: "颜色",
                      value: packageRows.map((row) => ({ name: row.sku1 }))
                    }],
                    skuInfoMap: Object.fromEntries(packageRows.map((row) => [
                      row.sku1,
                      {
                        specAttrs: row.sku1,
                        discountPrice: "6.90",
                        canBookCount: 10,
                        skuId: row.skuId
                      }
                    ]))
                  }
                }
              }
            },
            productPackInfo: {
              fields: {
                pieceWeightScale: {
                  pieceWeightScaleInfo: packageRows
                }
              }
            }
          }
        }
      }
    });

    expect(snapshot?.weightKg).toBeNull();
    const skus = snapshot?.skus ?? [];
    expect(skus).toHaveLength(13);
    expect(skus.find((sku) => sku.skuId === "6031984132315")).toMatchObject({
      weightKg: "0.08"
    });
    expect(skus.find((sku) => sku.skuId === "6031984132321")).toMatchObject({
      weightKg: "0.01"
    });
    expect(skus.every(
      (sku) => sku.weightKg === "0.08" || sku.weightKg === "0.01"
    )).toBe(true);
    expect(snapshot?.fieldEvidence?.weight).toBe("captured");
  });

  it("keeps mixed 1688 package dimensions on their concrete SKUs", () => {
    const packageRows = [
      {
        sku1: "小号",
        length: 40,
        width: 10,
        height: 2,
        weight: 120,
        skuId: 6031984132315
      },
      {
        sku1: "大号",
        length: 45,
        width: 10,
        height: 2,
        weight: 180,
        skuId: 6031984132316
      }
    ];
    const snapshot = read1688PageContext({
      context: {
        result: {
          data: {
            productTitle: { fields: { title: "不同规格包装尺寸商品" } },
            gallery: {
              fields: {
                offerId: 1000156593583,
                mainImage: ["https://cbu01.alicdn.com/img/ibank/mixed-dimensions.jpg"]
              }
            },
            Root: {
              fields: {
                dataJson: {
                  isSkuOffer: true,
                  skuModel: {
                    skuProps: [{
                      prop: "规格",
                      value: packageRows.map((row) => ({ name: row.sku1 }))
                    }],
                    skuInfoMap: Object.fromEntries(packageRows.map((row) => [
                      row.sku1,
                      {
                        specAttrs: row.sku1,
                        discountPrice: "6.90",
                        canBookCount: 10,
                        skuId: row.skuId
                      }
                    ]))
                  }
                }
              }
            },
            productPackInfo: {
              fields: {
                pieceWeightScale: {
                  pieceWeightScaleInfo: packageRows
                }
              }
            }
          }
        }
      }
    });

    expect(snapshot?.dimensionsCm).toBeNull();
    expect(snapshot?.skus?.find((sku) => sku.skuId === "6031984132315")).toMatchObject({
      dimensionsCm: { lengthCm: "40", widthCm: "10", heightCm: "2" }
    });
    expect(snapshot?.skus?.find((sku) => sku.skuId === "6031984132316")).toMatchObject({
      dimensionsCm: { lengthCm: "45", widthCm: "10", heightCm: "2" }
    });
    expect(snapshot?.fieldEvidence?.dimensions).toBe("captured");
  });
});
