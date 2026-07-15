import { describe, expect, it } from "vitest";
import {
  buildStageOverview,
  applyStageFilter,
  productStage,
  type ProductPoolItem
} from "./product-workbench.selectors";
import { productId, sourceItemId } from "@tk/contracts/ids";

function item(
  id: string,
  overrides: Partial<ProductPoolItem> = {}
): ProductPoolItem {
  return {
    productId: productId(id),
    sourceItemId: sourceItemId(`source-${id}`),
    canonicalSourceTitle: id,
    targetTitle: null,
    canonicalSuccessDetailId: null,
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    imageCount: 0,
    usableCanvasOutputCount: 0,
    miaoshouSource: "success",
    automation: "not_started",
    assetArchive: "pending",
    listing: "pending",
    canvas: "not_started",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: [],
    ...overrides
  };
}

const items = [
  item("pending"),
  item("processing", { automation: "running" }),
  item("review", {
    automation: "ready",
    assetArchive: "ready",
    listing: "ready",
    canvas: "succeeded"
  }),
  item("partial-review", {
    automation: "ready",
    assetArchive: "ready",
    listing: "ready",
    canvas: "partial",
    imageCount: 3,
    usableCanvasOutputCount: 1,
    warningCodes: ["canvas_partial"]
  }),
  item("attention", { automation: "needs_input" }),
  item("synced", { approval: "approved", miaoshouEdit: "succeeded" })
];

describe("stage overview projection", () => {
  it("exposes the six approved product-facing filters and their disjoint counts", () => {
    const stages = buildStageOverview(items);
    expect(Object.keys(stages)).toEqual([
      "all",
      "pending",
      "processing",
      "review",
      "needs_attention",
      "synced"
    ]);
    expect(Object.values(stages).map((stage) => stage.count)).toEqual([6, 1, 1, 2, 1, 1]);
    expect(Object.values(stages).map((stage) => stage.label)).toEqual([
      "全部（6）",
      "待处理（1）",
      "处理中（1）",
      "待确认（2）",
      "需处理（1）",
      "已同步妙手（1）"
    ]);
  });

  it("filters rows without mutating product state", () => {
    const before = items.map((row) => JSON.stringify(row));
    expect(applyStageFilter(items, "review").map((row) => String(row.productId))).toEqual([
      "review",
      "partial-review"
    ]);
    expect(items.map((row) => JSON.stringify(row))).toEqual(before);
  });

  it("does not treat original product images as usable partial Canvas outputs", () => {
    const partial = item("partial-with-originals-only", {
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "partial",
      imageCount: 9,
      usableCanvasOutputCount: 0
    });

    expect(productStage(partial)).toBe("needs_attention");
    expect(productStage({ ...partial, usableCanvasOutputCount: 1 })).toBe("review");
  });
});
