import { readFile } from "node:fs/promises";
import {
  assetId,
  idempotencyKey,
  miaoshouDetailId,
  productId,
  productRevisionId,
  sourceItemId,
  type ApprovalSnapshotV1
} from "@tk/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLiveMiaoshouEditAdapter, createMiaoshouEditAdapter } from "./edit-adapter.js";
import { mapApprovalSnapshotToMiaoshouEdit } from "./edit-mapper.js";
import { fingerprintMiaoshouEditableDetail, sha256Text, type MiaoshouEditExpectation } from "./reconcile-edit.js";
import type { MiaoshouHttp } from "./client.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../../tests/fixtures/external/miaoshou/${name}`, import.meta.url), "utf8"));

function approval(): ApprovalSnapshotV1 {
  const value: ApprovalSnapshotV1 = {
    approvalSnapshotId: "approval-1",
    productId: productId("product-1"),
    revisionId: productRevisionId("revision-1"),
    draftVersion: 3,
    listingRunId: "listing-1",
    pricingRunId: "pricing-1",
    templateVersion: 2,
    orderedFinalAssetIds: [assetId("asset-b"), assetId("asset-a")],
    sourcePlatform: "1688",
    sourceCanonicalUrl: "https://detail.1688.com/offer/892408514788.html",
    sourceItemId: sourceItemId("892408514788"),
    canonicalSuccessDetailId: miaoshouDetailId("3799770548"),
    locale: "th-TH",
    currency: "THB",
    title: "กางเกงขาสั้นผู้ชาย",
    description: "คำอธิบายสินค้า",
    attributes: [{ name: "วัสดุ", value: "ผ้าฝ้าย" }],
    itemNumber: "TK-001",
    priceWire: { amountMinor: "7128", currency: "THB" },
    stock: 200,
    weightKg: "0.300",
    dimensions: { lengthCm: "30.0", widthCm: "20.5", heightCm: "5" },
    skus: [{
      skuId: "SKU-RED-S",
      attributes: { สี: "แดง", ขนาด: "S" },
      priceWire: { amountMinor: "8050", currency: "THB" },
      stock: 50,
      assetIds: [assetId("asset-a")]
    }],
    createdAt: "2026-07-16T00:00:00.000Z"
  };
  return Object.freeze(value);
}

const remoteUrls = ["https://staging.test/final-b.png", "https://staging.test/final-a.png"];

describe("Miaoshou common collect-box edit mapper", () => {
  it("maps only title, translated content and images without price, stock or weight fields", () => {
    const mapped = mapApprovalSnapshotToMiaoshouEdit({
      ...approval(),
      priceWire: null,
      weightKg: null,
      skus: []
    }, remoteUrls);

    expect(mapped).toMatchObject({
      title: "กางเกงขาสั้นผู้ชาย",
      notesText: "คำอธิบายสินค้า",
      notes: "คำอธิบายสินค้า",
      imgUrls: remoteUrls
    });
    expect(mapped).not.toHaveProperty("price");
    expect(mapped).not.toHaveProperty("stock");
    expect(mapped).not.toHaveProperty("weight");
    expect(mapped).not.toHaveProperty("skuMap");
  });

  it("ignores approved price, stock, weight and sku price while preserving ordered remote images", () => {
    const mapped = mapApprovalSnapshotToMiaoshouEdit(approval(), remoteUrls);

    expect(mapped).toMatchObject({
      title: "กางเกงขาสั้นผู้ชาย",
      imgUrls: remoteUrls
    });
    expect(mapped).not.toHaveProperty("price");
    expect(mapped).not.toHaveProperty("stock");
    expect(mapped).not.toHaveProperty("weight");
    expect(mapped).not.toHaveProperty("skuMap");
  });

  it("truncates source attributes to Miaoshou's 255-character field limit", () => {
    const longValue = "红".repeat(300);
    const snapshot: ApprovalSnapshotV1 = {
      ...approval(),
      attributes: [{ name: "颜色".repeat(160), value: longValue }]
    };

    const mapped = mapApprovalSnapshotToMiaoshouEdit(snapshot, remoteUrls);

    expect(mapped.sourceAttrs[0]?.name).toHaveLength(255);
    expect(mapped.sourceAttrs[0]?.value).toHaveLength(255);
  });

  it("rejects reordered/missing staged URLs instead of silently changing approval order", () => {
    expect(() => mapApprovalSnapshotToMiaoshouEdit(approval(), remoteUrls.slice(0, 1))).toThrow(expect.objectContaining({
      kind: "needs_input",
      code: "miaoshou.edit_asset_order_mismatch"
    }));
  });
});

describe("Miaoshou common collect-box edit adapter", () => {
  it.each([408, 425])("treats real HTTP %i edit response as needs_reconcile without issuing a second write", async (status) => {
    const current = { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, sourceList: [{ sourceItemId: "892408514788" }] } } };
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return String(url).includes("get_common_collect_box_detail")
        ? new Response(JSON.stringify(current), { status: 200 })
        : new Response(null, { status });
    });
    const adapter = createLiveMiaoshouEditAdapter({
      baseUrl: "https://api.miaoshou.test",
      appKey: "test-key",
      appSecret: "test-secret"
    }, fetchImpl as unknown as typeof fetch);
    const input = { approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey(`edit:http-${status}`) };

    await expect(adapter.applyEdit(input)).resolves.toMatchObject({
      kind: "needs_reconcile",
      failure: { kind: "reconcile_required", code: "miaoshou.edit_result_unknown" }
    });
    await expect(adapter.applyEdit(input)).resolves.toMatchObject({
      kind: "needs_reconcile",
      failure: { code: "miaoshou.edit_reconciliation_pending" }
    });
    expect(requests.filter((request) => request.url.includes("edit_common_collect_box_detail"))).toHaveLength(1);
  });

  it("reconciles applied against the exact observable projection of the real GET fixture", async () => {
    const real = await fixture("detail-3799770548.json");
    const detail = real.data.editCommonCollectBoxDetail as Record<string, any>;
    const expected: MiaoshouEditExpectation = {
      version: 1,
      title: detail.title,
      notesText: detail.notesText,
      notes: detail.notes,
      imgUrlSha256: detail.imgUrls.map(sha256Text),
      sourceAttrs: detail.sourceAttrs
    };
    const adapter = createMiaoshouEditAdapter({
      http: { post: vi.fn(async () => real) } as MiaoshouHttp,
      expectationResolver: { resolve: vi.fn().mockResolvedValue(expected) }
    });

    await expect(adapter.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state: "applied" });
  });

  it("returns no_change when an edited observable field differs", async () => {
    const real = await fixture("detail-3799770548.json");
    const detail = real.data.editCommonCollectBoxDetail as Record<string, any>;
    const expected: MiaoshouEditExpectation = {
      version: 1,
      title: `${detail.title} changed`,
      notesText: detail.notesText,
      notes: detail.notes,
      imgUrlSha256: detail.imgUrls.map(sha256Text),
      sourceAttrs: detail.sourceAttrs
    };
    const adapter = createMiaoshouEditAdapter({ http: { post: vi.fn(async () => real) } as MiaoshouHttp, expectationResolver: { resolve: vi.fn().mockResolvedValue(expected) } });
    await expect(adapter.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toMatchObject({ state: "no_change" });
  });
  it("edits only the canonical detail and preserves full remote records", async () => {
    const success = await fixture("edit-success.json");
    const current = {
      result: "success", code: "200", data: {
        ossMd5: "before-md5",
        editCommonCollectBoxDetail: {
          commonCollectBoxDetailId: 3799770548,
          title: "旧标题",
          sourceList: [{ source: "1688", sourceItemId: "892408514788" }],
          skuMap: { ";แดง;S;": { itemNum: "SKU-RED-S", price: 6, stock: 60, oriPrice: 8, oriStock: 60, weight: 0.3 } }
        }
      }
    };
    const post = vi.fn(async (path: string) => path.includes("get_common_collect_box_detail") ? current : success);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });

    await expect(adapter.applyEdit({ approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey("edit:1") }))
      .resolves.toEqual({ kind: "succeeded", remoteDetailId: "3799770548" });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]).toEqual([
      "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail",
      { commonCollectBoxDetailId: 3799770548 }
    ]);
    const [editPath, body] = post.mock.calls[1] as unknown as [string, Record<string, any>];
    expect(editPath).toBe("/open/v1/product/common_collect_box/common_collect_box/edit_common_collect_box_detail");
    expect(body.commonCollectBoxDetailId).toBe(3799770548);
    expect(body.ossMd5).toBe("before-md5");
    expect(body.editCommonCollectBoxDetail.sourceList).toEqual(current.data.editCommonCollectBoxDetail.sourceList);
    expect(body.editCommonCollectBoxDetail).toMatchObject({
      title: "กางเกงขาสั้นผู้ชาย",
      notesText: "คำอธิบายสินค้า",
      notes: "คำอธิบายสินค้า",
      imgUrls: remoteUrls
    });
    expect(body.editCommonCollectBoxDetail.skuMap[";แดง;S;"]).toMatchObject({ oriPrice: 8, oriStock: 60, itemNum: "SKU-RED-S", price: 6, stock: 60, weight: 0.3 });
    expect(body.editCommonCollectBoxDetail.skuMap[";แดง;S;"]).not.toHaveProperty("attributes");
  });

  it("caps sale-property maps and keeps SKU combinations aligned before editing", async () => {
    const success = await fixture("edit-success.json");
    const largeApproval: ApprovalSnapshotV1 = {
      ...approval(),
      skus: Array.from({ length: 132 }, (_, index) => {
        const colorIndex = Math.floor(index / 2);
        const size = index % 2 === 0 ? "A" : "B";
        return {
          skuId: `SKU-${colorIndex}-${size}`,
          attributes: { สี: `color-${colorIndex}`, ขนาด: size },
          priceWire: { amountMinor: "8050", currency: "THB" as const },
          stock: 50,
          assetIds: [assetId("asset-a")]
        };
      })
    };
    const current = {
      result: "success", code: "200", data: {
        ossMd5: "before-md5",
        editCommonCollectBoxDetail: {
          commonCollectBoxDetailId: 3799770548,
          sourceList: [{ source: "1688", sourceItemId: "892408514788" }],
          colorMap: Object.fromEntries(Array.from({ length: 66 }, (_, index) => [`color-${index}`, { name: `color-${index}` }])),
          sizeMap: { A: { name: "A" }, B: { name: "B" } },
          saleProp3Map: Array.from({ length: 55 }, (_, index) => ({ name: `prop-${index}` })),
          skuMap: Object.fromEntries(largeApproval.skus.map((sku) => [`;${sku.attributes.สี};${sku.attributes.ขนาด};`, { itemNum: sku.skuId, price: 1, stock: 1, weight: 0.3 }]))
        }
      }
    };
    const post = vi.fn(async (path: string) => path.includes("get_common_collect_box_detail") ? current : success);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });

    await expect(adapter.applyEdit({ approvalSnapshot: largeApproval, orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey("edit:limits") }))
      .resolves.toEqual({ kind: "succeeded", remoteDetailId: "3799770548" });

    const [, body] = post.mock.calls[1] as unknown as [string, Record<string, any>];
    expect(Object.keys(body.editCommonCollectBoxDetail.colorMap)).toHaveLength(50);
    expect(Object.keys(body.editCommonCollectBoxDetail.sizeMap)).toHaveLength(2);
    expect(body.editCommonCollectBoxDetail.saleProp3Map).toHaveLength(50);
    expect(Object.keys(body.editCommonCollectBoxDetail.skuMap)).toHaveLength(100);
    expect(body.editCommonCollectBoxDetail.skuMap[";color-49;B;"]).toBeDefined();
    expect(body.editCommonCollectBoxDetail.skuMap[";color-50;A;"]).toBeUndefined();
  });

  it("returns stable UI field paths for upstream validation errors", async () => {
    const validation = await fixture("edit-validation-error.json");
    const post = vi.fn(async (path: string) => path.includes("get_common_collect_box_detail")
      ? { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: {} } }
      : validation);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });

    await expect(adapter.applyEdit({ approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey("edit:2") }))
      .resolves.toEqual({ kind: "validation_failed", fieldErrors: [
        { fieldPath: "title", message: "标题不能为空" },
        { fieldPath: "skus.SKU-RED-S.stock", message: "库存不能超过99999" },
        { fieldPath: "dimensions.lengthCm", message: "包装长度格式错误" }
      ] });
  });

  it("turns an unknown edit result into reconciliation-required and blocks a second edit", async () => {
    const current = { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, sourceList: [{ sourceItemId: "892408514788" }] } } };
    const timeout = Object.freeze({ kind: "retryable", code: "miaoshou.network", safeMessage: "Miaoshou API is temporarily unavailable" });
    const post = vi.fn()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(timeout);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });
    const input = { approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey("edit:3") };

    await expect(adapter.applyEdit(input)).resolves.toMatchObject({ kind: "needs_reconcile", failure: { kind: "reconcile_required", code: "miaoshou.edit_result_unknown" } });
    await expect(adapter.applyEdit(input)).resolves.toMatchObject({ kind: "needs_reconcile", failure: { code: "miaoshou.edit_reconciliation_pending" } });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "systemBusy", "500"])("treats HTTP 200 business code %s as an unknown write result", async (code) => {
    const current = { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, sourceList: [{ sourceItemId: "892408514788" }] } } };
    const post = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce({ result: "fail", code, message: "upstream status unknown" });
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });
    const input = { approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey(`edit:business-${code}`) };

    await expect(adapter.applyEdit(input)).resolves.toMatchObject({
      kind: "needs_reconcile",
      failure: { kind: "reconcile_required", code: "miaoshou.edit_result_unknown" }
    });
    await expect(adapter.applyEdit(input)).resolves.toMatchObject({ kind: "needs_reconcile", failure: { code: "miaoshou.edit_reconciliation_pending" } });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("reconciles by canonical detail/source/item number without issuing another edit", async () => {
    const currentBefore = { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, sourceList: [{ sourceItemId: "892408514788" }] } } };
    const realDetailFixture = await fixture("detail-3799770548.json");
    const realDetailShape = realDetailFixture.data.editCommonCollectBoxDetail;
    const [realSkuKey, realSkuValue] = Object.entries(realDetailShape.skuMap)[0] as [string, Record<string, unknown>];
    expect(realSkuKey).toMatch(/^;.*;$/);
    expect(realSkuValue).not.toHaveProperty("attributes");
    const mapped = mapApprovalSnapshotToMiaoshouEdit(approval(), remoteUrls);
    const currentAfter = { result: "success", code: "200", data: { ossMd5: "new", editCommonCollectBoxDetail: {
      ...realDetailShape,
      commonCollectBoxDetailId: 3799770548,
      sourceList: [{ source: "1688", sourceItemId: "892408514788" }],
      title: mapped.title,
      notesText: mapped.notesText,
      notes: mapped.notes,
      imgUrls: mapped.imgUrls,
      sourceAttrs: mapped.sourceAttrs
    } } };
    const timeout = Object.freeze({ kind: "retryable", code: "miaoshou.network", safeMessage: "Miaoshou API is temporarily unavailable" });
    const post = vi.fn().mockResolvedValueOnce(currentBefore).mockRejectedValueOnce(timeout).mockResolvedValueOnce(currentAfter);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });
    await adapter.applyEdit({ approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey("edit:4") });

    await expect(adapter.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state: "applied" });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.filter(([path]) => String(path).includes("edit_common_collect_box_detail"))).toHaveLength(1);
  });

  it.each([
    ["no_change", { result: "success", code: "200", data: { editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, itemNum: "old", sourceList: [{ sourceItemId: "892408514788" }] } } }],
    ["missing", { result: "fail", code: "detail_missing" }]
  ] as const)("keeps the duplicate-write barrier after reconciliation returns %s", async (state, reconcileResponse) => {
    const current = { result: "success", code: "200", data: { ossMd5: "md5", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, sourceList: [{ sourceItemId: "892408514788" }] } } };
    const timeout = Object.freeze({ kind: "retryable", code: "miaoshou.network", safeMessage: "Miaoshou API is temporarily unavailable" });
    const post = vi.fn().mockResolvedValueOnce(current).mockRejectedValueOnce(timeout).mockResolvedValueOnce(reconcileResponse);
    const adapter = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });
    const input = { approvalSnapshot: approval(), orderedRemoteAssetUrls: remoteUrls, idempotencyKey: idempotencyKey(`edit:barrier-${state}`) };
    await adapter.applyEdit(input);

    await expect(adapter.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state });
    await expect(adapter.applyEdit(input)).resolves.toMatchObject({ kind: "needs_reconcile", failure: { code: "miaoshou.edit_reconciliation_pending" } });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("fails closed after restart when the frozen reconcile port has no desired snapshot evidence", async () => {
    const remote = { result: "success", code: "200", data: { ossMd5: "new", editCommonCollectBoxDetail: { commonCollectBoxDetailId: 3799770548, itemNum: "TK-001", sourceList: [{ sourceItemId: "892408514788" }] } } };
    const post = vi.fn(async (_path: string) => remote);
    const restarted = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp });

    await expect(restarted.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state: "no_change" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.some(([path]) => String(path).includes("edit_common_collect_box_detail"))).toBe(false);
  });

  it("rebuilds the exact expectation through a repository resolver after process restart", async () => {
    const mapped = mapApprovalSnapshotToMiaoshouEdit(approval(), remoteUrls);
    const remote = { result: "success", code: "200", data: { editCommonCollectBoxDetail: {
      commonCollectBoxDetailId: 3799770548,
      sourceList: [{ sourceItemId: "892408514788" }],
      ...mapped
    } } };
    const expectation = fingerprintMiaoshouEditableDetail(mapped);
    expect(JSON.stringify(expectation)).not.toContain("https://staging.test");
    const resolve = vi.fn().mockResolvedValue(expectation);
    const post = vi.fn(async (_path: string) => remote);
    const restarted = createMiaoshouEditAdapter({ http: { post } as MiaoshouHttp, expectationResolver: { resolve } });

    await expect(restarted.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state: "applied" });
    expect(resolve).toHaveBeenCalledWith({ canonicalSuccessDetailId: "3799770548", sourceItemId: "892408514788" });
    expect(post.mock.calls.some(([path]) => String(path).includes("edit_common_collect_box_detail"))).toBe(false);
  });

  it("requires explicit canonical identity and exact edited fields", async () => {
    const mapped = mapApprovalSnapshotToMiaoshouEdit(approval(), remoteUrls);
    const expected = fingerprintMiaoshouEditableDetail(mapped);
    const base = { sourceList: [{ sourceItemId: "892408514788" }], ...mapped };
    const post = vi.fn()
      .mockResolvedValueOnce({ result: "success", data: { editCommonCollectBoxDetail: base } })
      .mockResolvedValueOnce({ result: "success", data: { editCommonCollectBoxDetail: {
        ...base,
        commonCollectBoxDetailId: 3799770548,
        title: `${mapped.title} changed`
      } } });
    const restarted = createMiaoshouEditAdapter({
      http: { post } as MiaoshouHttp,
      expectationResolver: { resolve: vi.fn().mockResolvedValue(expected) }
    });

    await expect(restarted.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toMatchObject({ state: "missing" });
    await expect(restarted.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toMatchObject({ state: "no_change" });
  });

  it("fails closed when the repository resolver cannot select one unambiguous expectation", async () => {
    const remote = { result: "success", code: "200", data: { editCommonCollectBoxDetail: {
      commonCollectBoxDetailId: 3799770548,
      sourceList: [{ sourceItemId: "892408514788" }]
    } } };
    const post = vi.fn(async (_path: string) => remote);
    const restarted = createMiaoshouEditAdapter({
      http: { post } as MiaoshouHttp,
      expectationResolver: { resolve: vi.fn().mockResolvedValue(undefined) }
    });

    await expect(restarted.reconcileByCanonicalDetailId({ canonicalSuccessDetailId: "3799770548", sourceItemId: sourceItemId("892408514788") }))
      .resolves.toEqual({ remoteDetailId: "3799770548", state: "no_change" });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
