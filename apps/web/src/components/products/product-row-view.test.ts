import { describe, expect, it } from "vitest";
import {
  miaoshouDetailId,
  productId,
  productRevisionId,
  sourceItemId
} from "@tk/contracts/ids";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import {
  buildImageProgress,
  buildProductIssue,
  buildProductRowView,
  STAGE_LABELS,
  STAGE_ORDER
} from "./product-row-view";

function item(overrides: Partial<ProductPoolItemV1> = {}): ProductPoolItemV1 {
  return {
    productId: productId("product-1"),
    currentRevisionId: productRevisionId("revision-1"),
    sourceItemId: sourceItemId("1688-1"),
    sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
    thumbnailUrl: "https://img.test/main.jpg",
    collectedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:10:00.000Z",
    canonicalSourceTitle: "源标题",
    targetTitle: null,
    canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
    locale: "th-TH",
    currency: "THB",
    priceWire: null,
    sourceImageCount: 9,
    imageCount: 0,
    usableCanvasOutputCount: 0,
    sourceCaptureQuality: null,
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

describe("product row view", () => {
  it("uses the approved six workbench tabs", () => {
    expect(STAGE_ORDER).toEqual([
      "all",
      "pending",
      "processing",
      "review",
      "needs_attention",
      "synced"
    ]);
    expect(STAGE_LABELS).toMatchObject({
      all: "全部",
      pending: "待处理",
      processing: "自动处理中",
      review: "待确认",
      needs_attention: "需要人工处理",
      synced: "已完成"
    });
  });

  it("projects pending rows to Start Processing", () => {
    const row = buildProductRowView(item());

    expect(row.businessStage).toBe("pending");
    expect(row.businessStatusLabel).toBe("待处理");
    expect(row.nextAction).toEqual({
      kind: "start",
      label: "开始处理",
      enabled: true
    });
    expect(row.canBatchStart).toBe(true);
    expect(row.canBatchConfirm).toBe(false);
  });

  it("starts a complete local 1688 capture without requiring a Miaoshou detail id", () => {
    const row = buildProductRowView(item({
      miaoshouSource: "local_captured",
      sourceCaptureQuality: "detail_page_complete",
      canonicalSuccessDetailId: null
    }));

    expect(row.sourceLabel).toBe("1688 本地采集 · 1688-1");
    expect(row.nextAction).toEqual({
      kind: "start",
      label: "开始处理",
      enabled: true
    });
    expect(row.issueLabel).toBeNull();
  });

  it("blocks historical unvalidated local captures until they are recaptured", () => {
    const row = buildProductRowView(item({
      miaoshouSource: "local_captured",
      sourceCaptureQuality: "detail_page",
      canonicalSuccessDetailId: null
    }));

    expect(row.businessStage).toBe("needs_attention");
    expect(row.nextAction).toEqual({
      kind: "issue",
      label: "查看原因",
      enabled: true,
      href: "/products/product-1"
    });
    expect(row.issueLabel).toBe("本地采集不完整，请重新采集");
    expect(row.canBatchStart).toBe(false);
  });

  it("projects an optimistically submitted row to progress instead of offering start again", () => {
    const row = buildProductRowView(item(), "success");

    expect(row.businessStage).toBe("processing");
    expect(row.businessStatusLabel).toBe("自动处理中");
    expect(row.imageProgressLabel).toBe("等待 Canvas · 主图 0/5");
    expect(row.nextAction).toEqual({
      kind: "progress",
      label: "查看进度",
      enabled: true,
      href: "/products/product-1"
    });
    expect(row.canBatchStart).toBe(false);
  });

  it("projects review rows to View and Confirm", () => {
    const row = buildProductRowView(item({
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      usableCanvasOutputCount: 5,
      targetTitle: "สร้อยคอจี้โคลเวอร์"
    }));

    expect(row.businessStage).toBe("review");
    expect(row.businessStatusLabel).toBe("待确认");
    expect(row.imageProgressLabel).toBe("主图 5/5");
    expect(row.nextAction).toEqual({
      kind: "review",
      label: "查看并确认",
      enabled: true,
      href: "/products/product-1"
    });
    expect(row.canBatchConfirm).toBe(true);
  });

  it("translates blocking issues into human-readable copy", () => {
    expect(buildProductIssue(item({ canonicalSuccessDetailId: null }))).toBeNull();
    expect(buildProductIssue(item({ sourceImageCount: 0 }))).toBe("1688 详情数据没有可用图片");
    expect(buildProductIssue(item({ canvas: "failed" }))).toBe("Canvas 生图失败，请查看原因或重试");
    expect(buildProductIssue(item({ canvas: "partial", usableCanvasOutputCount: 0 }))).toBe("Canvas 没有返回可用图片");
    expect(buildProductIssue(item({ miaoshouEdit: "result_unknown" }))).toBe("妙手写回结果未知，需要人工对账");
  });

  it("allows final confirmation to perform the late Miaoshou import", () => {
    const row = buildProductRowView(item({
      miaoshouSource: "local_captured",
      sourceCaptureQuality: "detail_page_complete",
      canonicalSuccessDetailId: null,
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      usableCanvasOutputCount: 5
    }));

    expect(row.businessStage).toBe("review");
    expect(row.canBatchConfirm).toBe(true);
  });

  it("does not count source images as Canvas outputs", () => {
    expect(buildImageProgress(item({ sourceImageCount: 9, usableCanvasOutputCount: 0 }))).toBe("主图 0/5");
    expect(buildImageProgress(item({ sourceImageCount: 9, usableCanvasOutputCount: 5 }))).toBe("主图 5/5");
  });

  it("makes Canvas generation status visible in the image progress column", () => {
    expect(buildImageProgress(item({ canvas: "queued", usableCanvasOutputCount: 0 }))).toBe("Canvas 排队中 · 主图 0/5");
    expect(buildImageProgress(item({ canvas: "running", usableCanvasOutputCount: 2 }))).toBe("Canvas 生图中 · 主图 2/5");
    expect(buildImageProgress(item({ automation: "needs_input", usableCanvasOutputCount: 0 }))).toBe("等待补充信息 · 主图 0/5");
  });
});
