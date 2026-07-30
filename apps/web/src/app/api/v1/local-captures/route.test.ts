import { describe, expect, it, vi } from "vitest";

import { createExtensionTokenVerifier } from "../../../../server/auth/extension-token";
import { createPostHandler } from "./route";

const body = {
  version: 3,
  batchId: "batch_local_01",
  items: [{
    sourceItemId: "892408514788",
    sourceUrl: "https://detail.1688.com/offer/892408514788.html",
    title: "测试商品",
    mainImages: ["https://cbu01.alicdn.com/img/ibank/main.jpg"],
    detailImages: [],
    descriptionText: "商品详情正文",
    attributes: [{ name: "材质", value: "不锈钢" }],
    skuAttributes: [{ name: "颜色", values: [{ name: "银色" }] }],
    skuText: ["颜色: 银色"],
    itemNumber: null,
    category: null,
    sourcePriceWire: { amountMinor: "1350", currency: "CNY" },
    sourcePriceRangeWire: {
      minAmountMinor: "1350",
      maxAmountMinor: "1350",
      currency: "CNY"
    },
    sourceStock: 159,
    weightKg: null,
    dimensionsCm: null,
    saleAttributes: [],
    colors: ["银色"],
    sizes: [],
    skus: [{
      skuId: "sku-silver",
      attributes: { 颜色: "银色" },
      priceWire: { amountMinor: "1350", currency: "CNY" },
      stock: 159,
      imageUrl: null
    }],
    capturedAt: "2026-07-24T08:00:00.000Z",
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
        dimensions: "source_absent"
      },
      expectedSkuCount: 1,
      capturedSkuCount: 1,
      acceptedMainImages: 1,
      acceptedDetailImages: 0,
      rejectedImages: 2,
      warnings: []
    },
    idempotencyKey: "1688:892408514788:batch_local_01"
  }]
};

function request(payload: unknown, token = "extension-secret") {
  return new Request("http://127.0.0.1:3000/api/v1/local-captures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
}

describe("POST /api/v1/local-captures", () => {
  it("persists complete captures and returns product identities", async () => {
    const ingestLocal = vi.fn(async () => ({
      accepted: 1,
      products: [{
        sourceItemId: "892408514788",
        productId: "prod-1",
        revisionId: "rev-1",
        created: true
      }],
      rejected: []
    }));
    const handler = createPostHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: { ingestLocal }
    });

    const response = await handler(request(body));

    expect(response.status).toBe(201);
    expect(ingestLocal).toHaveBeenCalledWith(body);
    await expect(response.json()).resolves.toMatchObject({
      accepted: 1,
      products: [{ productId: "prod-1", revisionId: "rev-1" }]
    });
  });

  it("rejects half-products before they reach the repository", async () => {
    const ingestLocal = vi.fn();
    const handler = createPostHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: { ingestLocal }
    });
    const invalid = {
      ...body,
      items: [{ ...body.items[0], mainImages: [], detailImages: [] }]
    };

    const response = await handler(request(invalid));

    expect(response.status).toBe(400);
    expect(ingestLocal).not.toHaveBeenCalled();
  });

  it.each([1, 2])("rejects legacy V%s captures with an explicit extension upgrade response", async (version) => {
    const ingestLocal = vi.fn();
    const handler = createPostHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: { ingestLocal }
    });

    const response = await handler(request({
      version,
      batchId: body.batchId,
      items: []
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "extension_upgrade_required",
      requiredVersion: 3
    });
    expect(ingestLocal).not.toHaveBeenCalled();
  });
});
