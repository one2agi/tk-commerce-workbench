// Wave 1 fixture pool shaped exactly as ProductPoolItemV1 from @tk/contracts.
// Hand-crafted so every aggregate state appears at least once — this lets the
// stage overview projection show non-zero counts in every card.

import { productId, productRevisionId, sourceItemId } from "@tk/contracts/ids";
import { cny, thb } from "@tk/contracts/quantities";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

export const fixtures: { productPool: ProductPoolItemV1[] } = {
  productPool: [
    {
      productId: productId("892408514788"),
      currentRevisionId: productRevisionId("revision-892408514788"),
      sourceItemId: sourceItemId("1688-A-001"),
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      thumbnailUrl: "https://img.test/892408514788.jpg",
      originalImageUrls: ["https://img.test/892408514788.jpg"],
      processedImageUrls: [],
      collectedAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:10:00.000Z",
      canonicalSourceTitle: "便携折叠收纳箱 30L",
      targetTitle: "กล่องเก็บของพับได้ 30 ลิตร",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "CNY",
      priceWire: cny("12900"),
      sourceImageCount: 9,
      sourceCaptureQuality: null,
      imageCount: 7,
      usableCanvasOutputCount: 0,
      miaoshouSource: "queued" as ProductPoolItemV1["miaoshouSource"],
      automation: "not_started",
      assetArchive: "pending",
      listing: "pending",
      canvas: "not_started",
      approval: "unapproved",
      miaoshouEdit: "not_started",
      warningCodes: []
    },
    {
      productId: productId("892408514999"),
      currentRevisionId: productRevisionId("revision-892408514999"),
      sourceItemId: sourceItemId("1688-A-002"),
      sourceUrl: "https://detail.1688.com/offer/892408514999.html",
      thumbnailUrl: "https://img.test/892408514999.jpg",
      originalImageUrls: ["https://img.test/892408514999.jpg"],
      processedImageUrls: [],
      collectedAt: "2026-07-22T10:05:00.000Z",
      updatedAt: "2026-07-22T10:15:00.000Z",
      canonicalSourceTitle: "304 不锈钢真空保温杯",
      targetTitle: "แก้วเก็บความร้อนสูญญากาศ 304",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "THB",
      priceWire: thb("28900"),
      sourceImageCount: 8,
      sourceCaptureQuality: null,
      imageCount: 6,
      usableCanvasOutputCount: 5,
      miaoshouSource: "success",
      automation: "running",
      assetArchive: "ready",
      listing: "ready",
      canvas: "succeeded",
      approval: "unapproved",
      miaoshouEdit: "not_started",
      warningCodes: []
    },
    {
      productId: productId("892408515123"),
      currentRevisionId: productRevisionId("revision-892408515123"),
      sourceItemId: sourceItemId("1688-A-003"),
      sourceUrl: "https://detail.1688.com/offer/892408515123.html",
      thumbnailUrl: "https://img.test/892408515123.jpg",
      originalImageUrls: ["https://img.test/892408515123.jpg"],
      processedImageUrls: [],
      collectedAt: "2026-07-22T10:20:00.000Z",
      updatedAt: "2026-07-22T10:30:00.000Z",
      canonicalSourceTitle: "USB-C 65W 氮化镓充电器",
      targetTitle: "ที่ชาร์จ GaN USB-C 65W",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "CNY",
      priceWire: cny("8800"),
      sourceImageCount: 4,
      sourceCaptureQuality: null,
      imageCount: 5,
      usableCanvasOutputCount: 0,
      miaoshouSource: "failed",
      automation: "needs_input",
      assetArchive: "failed",
      listing: "needs_input",
      canvas: "failed",
      approval: "unapproved",
      miaoshouEdit: "failed",
      warningCodes: ["W_PRICING_STALE"]
    }
  ]
};
