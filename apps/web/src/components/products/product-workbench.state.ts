// Workbench state machine — a tiny reducer-style API for selection, stage
// filter, drawer open/close and scroll position. The reducer is pure so it
// can be unit-tested without a DOM and re-used from React state via
// useReducer.

import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import {
  applyStageFilter,
  canStartAutomation,
  type StageKey
} from "./product-workbench.selectors";
import { buildProductRowView } from "./product-row-view";

export type ProductPoolItem = ProductPoolItemV1;
export type StartStatus = "idle" | "pending" | "success" | "failure";

export type WorkbenchState = Readonly<{
  items: ReadonlyArray<ProductPoolItem>;
  filtered: ReadonlyArray<ProductPoolItem>;
  selectedIds: ReadonlySet<string>;
  activeStage: StageKey;
  drawerProductId: string | null;
  scrollTop: number;
  startStatusById: ReadonlyMap<string, StartStatus>;
  // Labels are pre-computed so the React layer can render <button
  // aria-label={state.batchButtonLabel}> without recomputing.
  batchButtonLabel: string;
  batchButtonEnabled: boolean;
  batchStartLabel: string;
  batchStartEnabled: boolean;
  batchStartCount: number;
  batchConfirmLabel: string;
  batchConfirmEnabled: boolean;
  batchConfirmCount: number;
  batchRetryLabel: string;
  batchRetryEnabled: boolean;
  batchRetryCount: number;
  drawerStartButtonLabel: string;
  drawerStartButtonEnabled: boolean;
}>;

export function createWorkbenchState(items: ReadonlyArray<ProductPoolItem>): WorkbenchState {
  return derive({
    items,
    selectedIds: new Set<string>(),
    activeStage: "all",
    drawerProductId: null,
    scrollTop: 0,
    startStatusById: new Map()
  });
}

type Internal = {
  items: ReadonlyArray<ProductPoolItem>;
  selectedIds: Set<string>;
  activeStage: StageKey;
  drawerProductId: string | null;
  scrollTop: number;
  startStatusById: Map<string, StartStatus>;
};

function isStartable(item: ProductPoolItem, status: StartStatus): boolean {
  return canStartAutomation(item) && (status === "idle" || status === "failure");
}

function isSelectable(item: ProductPoolItem, status: StartStatus): boolean {
  const view = buildProductRowView(item, status);
  return view.canBatchStart || view.canBatchConfirm || view.canBatchRetry;
}

function derive(s: Internal): WorkbenchState {
  const filtered = applyStageFilter(s.items, s.activeStage);
  const selectedViews = s.items
    .filter((item) => s.selectedIds.has(String(item.productId)))
    .map((item) => buildProductRowView(item, s.startStatusById.get(String(item.productId)) ?? "idle"));
  const startCount = selectedViews.filter((view) => view.canBatchStart).length;
  const confirmCount = selectedViews.filter((view) => view.canBatchConfirm).length;
  const retryCount = selectedViews.filter((view) => view.canBatchRetry).length;
  const drawerItem = s.drawerProductId
    ? s.items.find((item) => String(item.productId) === s.drawerProductId)
    : undefined;
  return {
    items: s.items,
    filtered,
    selectedIds: s.selectedIds,
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    startStatusById: s.startStatusById,
    batchButtonLabel: `批量开始处理（${startCount}）`,
    batchButtonEnabled: startCount > 0,
    batchStartLabel: `批量开始处理（${startCount}）`,
    batchStartEnabled: startCount > 0,
    batchStartCount: startCount,
    batchConfirmLabel: `批量确认写回（${confirmCount}）`,
    batchConfirmEnabled: confirmCount > 0,
    batchConfirmCount: confirmCount,
    batchRetryLabel: `批量重试（${retryCount}）`,
    batchRetryEnabled: retryCount > 0,
    batchRetryCount: retryCount,
    drawerStartButtonLabel: drawerItem && s.startStatusById.get(String(drawerItem.productId)) === "failure"
      ? "重试处理"
      : "开始处理",
    drawerStartButtonEnabled: drawerItem
      ? isStartable(drawerItem, s.startStatusById.get(String(drawerItem.productId)) ?? "idle")
      : false
  };
}

export function toggleSelection(s: WorkbenchState, productId: string): WorkbenchState {
  const item = s.items.find((candidate) => String(candidate.productId) === productId);
  const next = new Set(s.selectedIds);
  if (next.has(productId)) {
    next.delete(productId);
  } else {
    if (!item || !isSelectable(item, s.startStatusById.get(productId) ?? "idle")) return s;
    next.add(productId);
  }
  return derive({
    items: s.items,
    selectedIds: next,
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    startStatusById: new Map(s.startStatusById)
  });
}

export function setStage(s: WorkbenchState, stage: StageKey): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: stage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    startStatusById: new Map(s.startStatusById)
  });
}

export function openDrawer(s: WorkbenchState, productId: string): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: productId,
    scrollTop: s.scrollTop,
    startStatusById: new Map(s.startStatusById)
  });
}

export function closeDrawer(s: WorkbenchState): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: null,
    scrollTop: s.scrollTop,
    startStatusById: new Map(s.startStatusById)
  });
}

export function recordScroll(s: WorkbenchState, scrollTop: number): WorkbenchState {
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop,
    startStatusById: new Map(s.startStatusById)
  });
}

export function refreshItems(
  s: WorkbenchState,
  items: ReadonlyArray<ProductPoolItem>
): WorkbenchState {
  const existingIds = new Set(items.map((item) => String(item.productId)));
  return derive({
    items,
    selectedIds: new Set([...s.selectedIds].filter((id) => existingIds.has(id))),
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId && existingIds.has(s.drawerProductId)
      ? s.drawerProductId
      : null,
    scrollTop: s.scrollTop,
    startStatusById: new Map(
      [...s.startStatusById].filter(([id]) => existingIds.has(id))
    )
  });
}

export function markStartPending(s: WorkbenchState, productIds: ReadonlyArray<string>): WorkbenchState {
  const statuses = new Map(s.startStatusById);
  for (const productId of productIds) statuses.set(productId, "pending");
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    startStatusById: statuses
  });
}

export function markStartResult(
  s: WorkbenchState,
  productId: string,
  result: "success" | "failure"
): WorkbenchState {
  const statuses = new Map(s.startStatusById);
  statuses.set(productId, result);
  return derive({
    items: s.items,
    selectedIds: new Set(s.selectedIds),
    activeStage: s.activeStage,
    drawerProductId: s.drawerProductId,
    scrollTop: s.scrollTop,
    startStatusById: statuses
  });
}

export function selectedStartableProductIds(s: WorkbenchState): string[] {
  return selectedBatchStartIds(s);
}

export function selectedBatchStartIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchStart
      ? [id]
      : [];
  });
}

export function selectedBatchConfirmIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchConfirm
      ? [id]
      : [];
  });
}

export function selectedBatchRetryIds(s: WorkbenchState): string[] {
  return s.items.flatMap((item) => {
    const id = String(item.productId);
    return s.selectedIds.has(id) && buildProductRowView(item, s.startStatusById.get(id) ?? "idle").canBatchRetry
      ? [id]
      : [];
  });
}
