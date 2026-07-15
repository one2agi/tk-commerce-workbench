"use client";

import { useCallback, useEffect, useMemo, useReducer, type ReactElement } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { StageOverview } from "./stage-overview";
import { ProductTable } from "./product-table";
import { ProductDrawer } from "./product-drawer";
import { AutomationProgress } from "./automation-progress";
import {
  buildAutomationProgress,
  buildStageOverview,
  type StageKey
} from "./product-workbench.selectors";
import {
  closeDrawer,
  createWorkbenchState,
  markStartPending,
  markStartResult,
  openDrawer,
  recordScroll,
  setStage,
  selectedStartableProductIds,
  toggleSelection,
  type WorkbenchState
} from "./product-workbench.state";
import {
  createHttpApiClient,
  dispatchStartAutomation,
  type ApiClient
} from "../../lib/api-client";

type Props = Readonly<{
  initialItems: ReadonlyArray<ProductPoolItemV1>;
  apiClient?: ApiClient;
  onStartAutomation?: (productIds: ReadonlyArray<string>) => void;
}>;

type Action =
  | { type: "toggle"; productId: string }
  | { type: "stage"; stage: StageKey }
  | { type: "open"; productId: string }
  | { type: "close" }
  | { type: "scroll"; scrollTop: number }
  | { type: "start-pending"; productIds: string[] }
  | { type: "start-result"; productId: string; result: "success" | "failure" };

function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case "toggle":
      return toggleSelection(state, action.productId);
    case "stage":
      return setStage(state, action.stage);
    case "open":
      return openDrawer(state, action.productId);
    case "close":
      return closeDrawer(state);
    case "scroll":
      return recordScroll(state, action.scrollTop);
    case "start-pending":
      return markStartPending(state, action.productIds);
    case "start-result":
      return markStartResult(state, action.productId, action.result);
  }
}

const defaultApiClient = createHttpApiClient();

export function ProductWorkbench({
  initialItems,
  apiClient = defaultApiClient,
  onStartAutomation
}: Props): ReactElement {
  const [state, dispatch] = useReducer(
    reducer,
    initialItems,
    createWorkbenchState
  );

  // Restore the recorded scrollTop onto the table region after each render.
  // We avoid ref-based DOM mutation by relying on a hidden mirror that the
  // table reads back — this keeps the React tree declarative.
  useEffect(() => {
    const region = document.querySelector<HTMLDivElement>(
      "[data-testid='product-table-scroll']"
    );
    if (region && region.scrollTop !== state.scrollTop) {
      region.scrollTop = state.scrollTop;
    }
  }, [state.scrollTop, state.filtered]);

  const overview = useMemo(() => buildStageOverview(initialItems), [initialItems]);

  const drawerItem = useMemo<ProductPoolItemV1 | null>(() => {
    if (!state.drawerProductId) return null;
    return (
      initialItems.find((i) => String(i.productId) === state.drawerProductId) ?? null
    );
  }, [state.drawerProductId, initialItems]);

  const progressItem = useMemo<ProductPoolItemV1 | null>(() => {
    if (drawerItem) return drawerItem;
    if (state.selectedIds.size !== 1) return null;
    const selectedId = state.selectedIds.values().next().value as string | undefined;
    return initialItems.find((item) => String(item.productId) === selectedId) ?? null;
  }, [drawerItem, initialItems, state.selectedIds]);

  const startProducts = useCallback(async (productIds: ReadonlyArray<string>) => {
    dispatch({ type: "start-pending", productIds: [...productIds] });
    onStartAutomation?.(productIds);
    await Promise.all(productIds.map(async (productId) => {
      const item = initialItems.find((candidate) => String(candidate.productId) === productId);
      if (!item) {
        dispatch({ type: "start-result", productId, result: "failure" });
        return;
      }
      try {
        await dispatchStartAutomation(apiClient, {
          revisionIds: [String(item.currentRevisionId)]
        });
        dispatch({ type: "start-result", productId, result: "success" });
      } catch {
        dispatch({ type: "start-result", productId, result: "failure" });
      }
    }));
  }, [apiClient, initialItems, onStartAutomation]);

  const handleStart = useCallback((productId: string) => {
    void startProducts([productId]);
  }, [startProducts]);

  const handleBatchStart = useCallback(() => {
    const productIds = selectedStartableProductIds(state);
    if (productIds.length === 0) return;
    void startProducts(productIds);
  }, [startProducts, state]);

  return (
    <section className="tk-product-workbench" aria-label="商品工作台">
      <StageOverview
        overview={overview}
        activeStage={state.activeStage}
        onSelect={(stage) => dispatch({ type: "stage", stage })}
      />
      <div className="tk-product-workbench__body">
        <ProductTable
          items={state.items}
          filtered={state.filtered}
          selectedIds={state.selectedIds}
          startStatusById={state.startStatusById}
          activeStage={state.activeStage}
          onToggleSelection={(id) => dispatch({ type: "toggle", productId: id })}
          onOpenDrawer={(id) => dispatch({ type: "open", productId: id })}
          onScroll={(scrollTop) => dispatch({ type: "scroll", scrollTop })}
          scrollTop={state.scrollTop}
        />
        <ProductDrawer
          item={drawerItem}
          open={state.drawerProductId !== null}
          startButtonLabel={state.drawerStartButtonLabel}
          startButtonEnabled={state.drawerStartButtonEnabled}
          onClose={() => dispatch({ type: "close" })}
          onStart={handleStart}
        />
      </div>
      <footer className="tk-product-workbench__footer">
        <button
          type="button"
          aria-label={state.batchButtonLabel}
          disabled={!state.batchButtonEnabled}
          onClick={handleBatchStart}
        >
          {state.batchButtonLabel}
        </button>
        {progressItem ? (
          <AutomationProgress
            productId={String(progressItem.productId)}
            nodes={buildAutomationProgress(progressItem)}
          />
        ) : (
          <span className="tk-automation-progress__empty">选择一个商品查看真实进度</span>
        )}
      </footer>
    </section>
  );
}
