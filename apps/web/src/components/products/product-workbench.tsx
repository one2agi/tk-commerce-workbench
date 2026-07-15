"use client";

import { useCallback, useEffect, useMemo, useReducer, type ReactElement } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { StageOverview } from "./stage-overview";
import { ProductTable } from "./product-table";
import { ProductDrawer } from "./product-drawer";
import { AutomationProgress } from "./automation-progress";
import {
  buildStageOverview,
  type StageKey
} from "./product-workbench.selectors";
import {
  closeDrawer,
  createWorkbenchState,
  openDrawer,
  recordScroll,
  setStage,
  toggleSelection,
  type WorkbenchState
} from "./product-workbench.state";
import { dispatchStartAutomation, type ApiClient } from "../../lib/api-client";

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
  | { type: "scroll"; scrollTop: number };

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
  }
}

const stubClient: ApiClient = {
  send: () => ({ accepted: true })
};

export function ProductWorkbench({
  initialItems,
  apiClient = stubClient,
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

  const handleStart = useCallback(
    (productId: string) => {
      // Map each productId to a revisionId via a stable hash for Wave 1; Wave 2
      // will replace this with a real revisionId from the server.
      const revisionId = `rev-${productId}`;
      dispatchStartAutomation(apiClient, { revisionIds: [revisionId] });
      onStartAutomation?.([productId]);
    },
    [apiClient, onStartAutomation]
  );

  const handleBatchStart = useCallback(() => {
    if (state.selectedIds.size === 0) return;
    const revisionIds = Array.from(state.selectedIds).map((p) => `rev-${p}`);
    dispatchStartAutomation(apiClient, { revisionIds });
    onStartAutomation?.(Array.from(state.selectedIds));
  }, [apiClient, onStartAutomation, state.selectedIds]);

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
        <AutomationProgress
          nodes={[
            { key: "collect", label: "采集", state: "running" },
            { key: "listing", label: "Listing", state: "pending" },
            { key: "canvas", label: "Canvas", state: "pending" },
            { key: "edit", label: "妙手编辑", state: "pending" }
          ]}
        />
      </footer>
    </section>
  );
}
