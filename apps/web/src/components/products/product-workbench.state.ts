// Workbench state machine — a tiny reducer-style API for selection, stage
// filter, drawer open/close and scroll position. The reducer is pure so it
// can be unit-tested without a DOM and re-used from React state via
// useReducer.

import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import type { StageKey } from "./product-workbench.selectors";

export type ProductPoolItem = ProductPoolItemV1;

export type WorkbenchState = Readonly<{
  items: ReadonlyArray<ProductPoolItem>;
  filtered: ReadonlyArray<ProductPoolItem>;
  selectedIds: ReadonlySet<string>;
  activeStage: StageKey;
  drawerProductId: string | null;
  scrollTop: number;
  // Labels are pre-computed so the React layer can render <button
  // aria-label={state.batchButtonLabel}> without recomputing.
  batchButtonLabel: string;
  batchButtonEnabled: boolean;
  drawerStartButtonLabel: string;
}>;

export function createWorkbenchState(items: ReadonlyArray<ProductPoolItem>): WorkbenchState {
  return derive({
    items,
    selectedIds: new Set<string>(),
    activeStage: "all",
    drawerProductId: null,
    scrollTop: 0
  });
}

type Internal = {
  items: ReadonlyArray<ProductPoolItem>;
  selectedIds: Set<string>;
  activeStage: StageKey;
  drawerProductId: string | null;
  scrollTop: number;
};

function derive(s: Internal): WorkbenchState {
  const filtered = filterByStage(s.items, s.activeStage);
  const count = s.selectedIds.size;
  return {
    items: s.items,
    filtered,
    selectedIds: s.selectedIds,
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    batchButtonLabel: `批量开始处理（${count}）`,
    batchButtonEnabled: count > 0,
    drawerStartButtonLabel: "开始处理"
  };
}

function filterByStage(items: ReadonlyArray<ProductPoolItem>, stage: StageKey): ReadonlyArray<ProductPoolItem> {
  switch (stage) {
    case "all":
      return items;
    case "collection":
      return items.filter((i) => !["success", "skipped_duplicate"].includes(i.miaoshouSource));
    case "listing":
      return items.filter((i) => i.listing !== "ready");
    case "miaoshouEdit":
      return items.filter((i) => i.miaoshouEdit !== "succeeded");
  }
}

export function toggleSelection(s: WorkbenchState, productId: string): WorkbenchState {
  const next = new Set(s.selectedIds);
  if (next.has(productId)) next.delete(productId);
  else next.add(productId);
  return derive({
    items: s.items,
    selectedIds: next,
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop
  });
}

export function setStage(s: WorkbenchState, stage: StageKey): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: stage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop
  });
}

export function openDrawer(s: WorkbenchState, productId: string): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: productId,
    scrollTop: s.scrollTop
  });
}

export function closeDrawer(s: WorkbenchState): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: null,
    scrollTop: s.scrollTop
  });
}

export function recordScroll(s: WorkbenchState, scrollTop: number): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop
  });
}