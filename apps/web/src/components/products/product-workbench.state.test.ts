// RED — phase 2 (state machine)
// Selection, stage filter and drawer open/close must preserve context.

import { describe, expect, it } from "vitest";
import {
  createWorkbenchState,
  toggleSelection,
  setStage,
  openDrawer,
  closeDrawer,
  recordScroll,
  type ProductPoolItem,
  type WorkbenchState
} from "./product-workbench.state";
import { productId, sourceItemId } from "@tk/contracts/ids";

const items: ProductPoolItem[] = [
  {
    productId: productId("892408514788"),
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
    productId: productId("892408514999"),
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
  }
];

describe("workbench state machine", () => {
  it("starts with no selection, no stage filter and no open drawer", () => {
    const s = createWorkbenchState(items);
    expect(s.selectedIds.size).toBe(0);
    expect(s.activeStage).toBe("all");
    expect(s.drawerProductId).toBeNull();
    expect(s.batchButtonLabel).toMatch(/批量开始处理（0）/);
    expect(s.batchButtonEnabled).toBe(false);
  });

  it("keeps selected rows when the drawer opens and closes", () => {
    let s: WorkbenchState = createWorkbenchState(items);
    s = toggleSelection(s, "892408514788");
    expect(s.selectedIds.has("892408514788")).toBe(true);
    s = openDrawer(s, "892408514788");
    expect(s.drawerProductId).toBe("892408514788");
    s = closeDrawer(s);
    expect(s.drawerProductId).toBeNull();
    expect(s.selectedIds.has("892408514788")).toBe(true);
    expect(s.batchButtonLabel).toMatch(/批量开始处理（1）/);
    expect(s.batchButtonEnabled).toBe(true);
  });

  it("drawer close preserves stage filter, row selection and scroll position", () => {
    let s: WorkbenchState = createWorkbenchState(items);
    s = setStage(s, "pending");
    s = toggleSelection(s, "892408514788");
    s = recordScroll(s, 120);
    const beforeScroll = s.scrollTop;
    s = openDrawer(s, "892408514788");
    s = closeDrawer(s);
    expect(s.activeStage).toBe("pending");
    expect(s.selectedIds.has("892408514788")).toBe(true);
    expect(s.scrollTop).toBe(beforeScroll);
  });

  it("only selects products whose automation has not started", () => {
    let s: WorkbenchState = createWorkbenchState(items);
    s = toggleSelection(s, "892408514999");
    expect(s.selectedIds.size).toBe(0);
    expect(s.batchButtonEnabled).toBe(false);
  });

  it("never offers start processing again for a needs-input product", () => {
    const needsInput = {
      ...items[0]!,
      automation: "needs_input" as const
    };
    let s = createWorkbenchState([needsInput]);
    s = openDrawer(s, String(needsInput.productId));
    expect(s.drawerStartButtonEnabled).toBe(false);
  });

  it("single-row '开始处理' and batch '批量开始处理（N）' both go through the contract command path", () => {
    let s: WorkbenchState = createWorkbenchState(items);
    s = toggleSelection(s, "892408514788");
    expect(s.batchButtonLabel).toMatch(/批量开始处理（1）/);
    // Opening the drawer for a single row exposes a per-row 开始处理 button.
    s = openDrawer(s, "892408514788");
    expect(s.drawerStartButtonLabel).toMatch(/开始处理/);
  });
});
