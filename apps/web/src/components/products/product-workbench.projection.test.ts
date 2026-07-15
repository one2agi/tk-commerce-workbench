// RED — phase 1 (projection)
// Stage overview counts must derive from per-aggregate state projections.
// A stage card click must never mutate product status.

import { describe, expect, it } from "vitest";
import {
  buildStageOverview,
  applyStageFilter,
  type ProductPoolItem,
  type StageKey
} from "./product-workbench.selectors";
import { productId, sourceItemId } from "@tk/contracts/ids";

const items: ProductPoolItem[] = [
  {
    productId: productId("p-1"),
    sourceItemId: sourceItemId("s-1"),
    canonicalSourceTitle: "A",
    targetTitle: null,
    canonicalSuccessDetailId: null,
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    imageCount: 0,
    miaoshouSource: "queued" as ProductPoolItem["miaoshouSource"],
    automation: "not_started",
    assetArchive: "pending",
    listing: "pending",
    canvas: "not_started",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: []
  },
  {
    productId: productId("p-2"),
    sourceItemId: sourceItemId("s-2"),
    canonicalSourceTitle: "B",
    targetTitle: null,
    canonicalSuccessDetailId: null,
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    imageCount: 0,
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
    productId: productId("p-3"),
    sourceItemId: sourceItemId("s-3"),
    canonicalSourceTitle: "C",
    targetTitle: null,
    canonicalSuccessDetailId: null,
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    imageCount: 0,
    miaoshouSource: "failed",
    automation: "needs_input",
    assetArchive: "failed",
    listing: "needs_input",
    canvas: "failed",
    approval: "unapproved",
    miaoshouEdit: "failed",
    warningCodes: []
  }
];

describe("stage overview projection", () => {
  it("counts each stage from per-aggregate states, never from a shortcut total", () => {
    const stages = buildStageOverview(items);
    // collection stage counts miaoshouSource not in (success, skipped_duplicate)
    expect(stages.collection.count).toBe(2); // queued + failed
    // listing stage counts listing not in (ready)
    expect(stages.listing.count).toBe(2); // pending + needs_input
    // miaoshou-edit stage counts miaoshouEdit not in (succeeded)
    // Fixtures have 2× not_started + 1× failed (p-2 not yet edited) = 3
    expect(stages.miaoshouEdit.count).toBe(3);
  });

  it("every stage card has a non-empty accessible label with a digit", () => {
    const stages = buildStageOverview(items);
    for (const stage of Object.values(stages)) {
      expect(stage.label).toMatch(/\d/);
      expect(stage.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("clicking a stage filters rows without mutating any product state", () => {
    const stage: StageKey = "collection";
    const before = items.map((i) => JSON.stringify(i));
    const filtered = applyStageFilter(items, stage);
    const after = items.map((i) => JSON.stringify(i));
    // original items must be untouched
    expect(after).toEqual(before);
    // filtered list only contains items whose miaoshouSource is not terminal-success
    for (const item of filtered) {
      expect(["queued", "submitted", "pending", "failed", "partial"]).toContain(
        item.miaoshouSource
      );
    }
  });
});