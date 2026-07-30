import { describe, expect, it } from "vitest";
import {
  buildStageOverview,
  buildAutomationProgress,
  applyStageFilter,
  productStage,
  type ProductPoolItem
} from "./product-workbench.selectors";
import { productId, productRevisionId, sourceItemId } from "@tk/contracts/ids";

function item(
  id: string,
  overrides: Partial<ProductPoolItem> = {}
): ProductPoolItem {
  return {
    productId: productId(id),
    currentRevisionId: productRevisionId(`revision-${id}`),
    sourceItemId: sourceItemId(`source-${id}`),
    sourceUrl: `https://detail.1688.com/offer/${id}.html`,
    thumbnailUrl: `https://img.test/${id}.jpg`,
    originalImageUrls: [`https://img.test/${id}.jpg`],
    processedImageUrls: [],
    collectedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:10:00.000Z",
    canonicalSourceTitle: id,
    targetTitle: null,
    canonicalSuccessDetailId: null,
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    sourceImageCount: 0,
    sourceCaptureQuality: null,
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
      "自动处理中（1）",
      "待确认（2）",
      "需要人工处理（1）",
      "已完成（1）"
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

  it("derives each progress node from the focused product's persisted aggregate states", () => {
    const focused = item("focused", {
      automation: "running",
      assetArchive: "ready",
      listing: "ready",
      canvas: "partial",
      miaoshouEdit: "result_unknown"
    });

    expect(buildAutomationProgress(focused)).toEqual([
      { key: "collect", label: "采集", state: "ready" },
      { key: "listing", label: "上架草稿", state: "ready" },
      { key: "canvas", label: "Canvas", state: "ready" },
      { key: "edit", label: "妙手编辑", state: "failed" }
    ]);
  });
});
