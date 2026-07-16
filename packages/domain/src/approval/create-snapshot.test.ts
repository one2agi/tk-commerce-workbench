import { describe, expect, it } from "vitest";

import type { ApprovalSnapshotV1 } from "@tk/contracts";

import { createApprovalSnapshot, type ApprovalSnapshotMaterial } from "./create-snapshot.js";
import { invalidatesApproval } from "./invalidate-approval.js";

const material = {
  approvalSnapshotId: "approval-1",
  productId: "product-1",
  revisionId: "revision-1",
  draftVersion: 4,
  listingRunId: "listing-4",
  pricingRunId: "pricing-4",
  templateVersion: 7,
  orderedFinalAssetIds: ["asset-main", "asset-detail"],
  sourceCanonicalUrl: "https://detail.1688.com/offer/892408514788.html",
  sourceItemId: "892408514788",
  canonicalSuccessDetailId: "detail-3799770548",
  locale: "th-TH",
  currency: "THB",
  title: "เสื้อยืด",
  description: "รายละเอียดสินค้า",
  attributes: [{ name: "material", value: "cotton" }],
  itemNumber: "MS-100",
  priceWire: { amountMinor: "25900", currency: "THB" },
  stock: 21,
  weightKg: "0.35",
  dimensions: { lengthCm: "30", widthCm: "20", heightCm: "4" },
  skus: [{
    skuId: "sku-red-m",
    attributes: { color: "red", size: "M" },
    priceWire: { amountMinor: "25900", currency: "THB" },
    stock: 8,
    assetIds: ["asset-main"]
  }],
  createdAt: "2026-07-16T00:00:00.000Z"
} as const satisfies Record<string, unknown>;

const approvalMaterial = material as unknown as ApprovalSnapshotMaterial;

describe("createApprovalSnapshot", () => {
  it("captures the complete approved material and deep-freezes it", () => {
    const snapshot = createApprovalSnapshot(approvalMaterial);

    expect(snapshot).toEqual({ ...material, sourcePlatform: "1688" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.orderedFinalAssetIds)).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0]?.attributes)).toBe(true);
    expect(() => (snapshot.orderedFinalAssetIds as string[]).reverse()).toThrow();
  });
});

describe("invalidatesApproval", () => {
  const snapshot = createApprovalSnapshot(approvalMaterial);

  it.each([
    ["title", { title: "changed" }],
    ["image order", { orderedFinalAssetIds: ["asset-detail", "asset-main"] }],
    ["language", { locale: "en-US" }],
    ["template", { templateVersion: 8 }],
    ["price", { priceWire: { amountMinor: "29900", currency: "THB" } }]
  ])("invalidates after editing %s", (_label, changed) => {
    expect(invalidatesApproval(snapshot, { ...snapshot, ...changed } as ApprovalSnapshotV1)).toBe(true);
  });

  it("keeps approval valid when material is unchanged", () => {
    expect(invalidatesApproval(snapshot, structuredClone(snapshot))).toBe(false);
  });
});
