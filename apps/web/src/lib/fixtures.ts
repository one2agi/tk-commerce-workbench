// Wave 1 fixture pool shaped exactly as ProductPoolItemV1 from @tk/contracts.
// Hand-crafted so every aggregate state appears at least once — this lets the
// stage overview projection show non-zero counts in every card.

import { productId, sourceItemId } from "@tk/contracts/ids";
import { cny, thb } from "@tk/contracts/quantities";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

export const fixtures: { productPool: ProductPoolItemV1[] } = {
  productPool: [
    {
      productId: productId("892408514788"),
      sourceItemId: sourceItemId("1688-A-001"),
      canonicalSourceTitle: "便携折叠收纳箱 30L",
      targetTitle: "กล่องเก็บของพับได้ 30 ลิตร",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "CNY",
      priceWire: cny("12900"),
      imageCount: 7,
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
      sourceItemId: sourceItemId("1688-A-002"),
      canonicalSourceTitle: "304 不锈钢真空保温杯",
      targetTitle: "แก้วเก็บความร้อนสูญญากาศ 304",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "THB",
      priceWire: thb("28900"),
      imageCount: 6,
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
      sourceItemId: sourceItemId("1688-A-003"),
      canonicalSourceTitle: "USB-C 65W 氮化镓充电器",
      targetTitle: "ที่ชาร์จ GaN USB-C 65W",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "CNY",
      priceWire: cny("8800"),
      imageCount: 5,
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