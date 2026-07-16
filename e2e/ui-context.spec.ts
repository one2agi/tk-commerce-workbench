import { expect, test } from "@playwright/test";
import { ProductDrawer } from "../apps/web/src/components/products/product-drawer.js";
import { ProductTable } from "../apps/web/src/components/products/product-table.js";
import {
  createWorkbenchState,
  openDrawer,
  recordScroll,
  refreshItems,
  setStage,
  toggleSelection,
  type ProductPoolItem
} from "../apps/web/src/components/products/product-workbench.state.js";

function item(id: string, title: string): ProductPoolItem {
  return {
    productId: id as never,
    currentRevisionId: `revision-${id}` as never,
    sourceItemId: `source-${id}` as never,
    canonicalSourceTitle: title,
    targetTitle: null,
    canonicalSuccessDetailId: `detail-${id}` as never,
    locale: "th-TH",
    currency: "THB",
    priceWire: null,
    imageCount: 2,
    usableCanvasOutputCount: 0,
    miaoshouSource: "success",
    automation: "not_started",
    assetArchive: "pending",
    listing: "pending",
    canvas: "not_started",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: []
  };
}

type RenderNode = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined;

function nodes(root: RenderNode): RenderNode[] {
  const result: RenderNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "string" || typeof value === "number") {
      result.push(value);
      return;
    }
    if (typeof value === "object") {
      const node = value as { props?: Record<string, unknown> };
      result.push(node);
      visit(node.props?.children);
    }
  };
  visit(root);
  return result;
}

function visibleText(root: RenderNode): string {
  return nodes(root).filter((node): node is string | number => typeof node === "string" || typeof node === "number").join(" ");
}

test("刷新数据或完成动作后仍保留用户可见的筛选、勾选、抽屉与滚动上下文", () => {
  const first = item("892408514788", "轻薄防晒男士夹克");
  const sibling = item("892408514999", "运动短裤");
  let state = createWorkbenchState([first, sibling]);
  state = setStage(state, "pending");
  state = toggleSelection(state, String(first.productId));
  state = openDrawer(state, String(first.productId));
  state = recordScroll(state, 176);

  const refreshed = { ...first, canonicalSourceTitle: "轻薄防晒男士夹克（已刷新）", targetTitle: "เสื้อแจ็กเก็ตกันแดด" };
  state = refreshItems(state, [refreshed, sibling]);

  const tableTree = ProductTable({
    items: state.items,
    filtered: state.filtered,
    selectedIds: state.selectedIds,
    startStatusById: state.startStatusById,
    activeStage: state.activeStage,
    onToggleSelection: () => undefined,
    onOpenDrawer: () => undefined,
    onScroll: () => undefined,
    scrollTop: state.scrollTop
  });
  const drawerTree = ProductDrawer({
    item: state.items.find((candidate) => String(candidate.productId) === state.drawerProductId) ?? null,
    open: state.drawerProductId !== null,
    startButtonLabel: state.drawerStartButtonLabel,
    startButtonEnabled: state.drawerStartButtonEnabled,
    onClose: () => undefined,
    onStart: () => undefined
  });

  expect(state.activeStage).toBe("pending");
  expect(state.selectedIds).toEqual(new Set([String(first.productId)]));
  expect(state.drawerProductId).toBe(String(first.productId));
  expect(state.scrollTop).toBe(176);
  expect((tableTree.props as Record<string, unknown>)["aria-label"]).toBe("待处理商品表（2/2）");
  expect(nodes(tableTree as unknown as RenderNode).some((node) => typeof node === "object" && node?.props?.["aria-selected"] === true)).toBe(true);
  expect(nodes(tableTree as unknown as RenderNode).some((node) => typeof node === "object" && node?.props?.["data-scroll-top-mirror"] === 176)).toBe(true);
  expect(visibleText(tableTree as unknown as RenderNode)).toContain("轻薄防晒男士夹克（已刷新）");
  expect((drawerTree.props as Record<string, unknown>).role).toBe("dialog");
  expect(visibleText(drawerTree as unknown as RenderNode)).toContain("เสื้อแจ็กเก็ตกันแดด");
  expect(visibleText(drawerTree as unknown as RenderNode)).toContain("开始处理");
});

test("刷新移除商品时只清理失效上下文，不把抽屉错绑到另一商品", () => {
  const removed = item("removed", "即将移除");
  const remaining = item("remaining", "仍在列表");
  let state = createWorkbenchState([removed, remaining]);
  state = toggleSelection(state, String(removed.productId));
  state = openDrawer(state, String(removed.productId));
  state = recordScroll(state, 88);

  state = refreshItems(state, [remaining]);

  const drawerTree = ProductDrawer({
    item: null,
    open: state.drawerProductId !== null,
    startButtonLabel: state.drawerStartButtonLabel,
    startButtonEnabled: state.drawerStartButtonEnabled,
    onClose: () => undefined,
    onStart: () => undefined
  });
  expect(state.selectedIds.size).toBe(0);
  expect(state.drawerProductId).toBeNull();
  expect(state.scrollTop).toBe(88);
  expect(String((drawerTree.props as Record<string, unknown>)["aria-hidden"])).toBe("true");
  expect(visibleText(drawerTree as unknown as RenderNode)).not.toContain("仍在列表");
});
