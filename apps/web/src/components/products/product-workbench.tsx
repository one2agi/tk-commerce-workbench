"use client";

import { useCallback, useEffect, useMemo, useReducer, useState, type ReactElement } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { StageOverview } from "./stage-overview";
import { ProductTable } from "./product-table";
import { ProductDrawer } from "./product-drawer";
import { AutomationProgress } from "./automation-progress";
import {
  buildAutomationProgress,
  buildStageOverview,
  productStage,
  type StageKey
} from "./product-workbench.selectors";
import {
  closeDrawer,
  createWorkbenchState,
  markStartPending,
  markStartResult,
  openDrawer,
  recordScroll,
  refreshItems,
  selectedBatchConfirmIds,
  selectedBatchRetryIds,
  setStage,
  selectedStartableProductIds,
  toggleSelection,
  type WorkbenchState
} from "./product-workbench.state";
import {
  createHttpApiClient,
  dispatchBatchProductAction,
  dispatchStartAutomation,
  fetchProductPool,
  summarizeBatchProductActionResult,
  type ApiClient
} from "../../lib/api-client";

type Props = Readonly<{
  initialItems: ReadonlyArray<ProductPoolItemV1>;
  apiClient?: ApiClient;
  batchActionFetcher?: typeof fetch;
  productFetcher?: typeof fetch;
  refreshIntervalMs?: number | null;
  onStartAutomation?: (productIds: ReadonlyArray<string>) => void;
  onBatchConfirm?: (productIds: ReadonlyArray<string>) => void;
  onBatchRetry?: (productIds: ReadonlyArray<string>) => void;
}>;

type Action =
  | { type: "toggle"; productId: string }
  | { type: "stage"; stage: StageKey }
  | { type: "open"; productId: string }
  | { type: "close" }
  | { type: "scroll"; scrollTop: number }
  | { type: "refresh"; items: ReadonlyArray<ProductPoolItemV1> }
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
    case "refresh":
      return refreshItems(state, action.items);
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
  batchActionFetcher = fetch,
  productFetcher = fetch,
  refreshIntervalMs = 3_000,
  onStartAutomation,
  onBatchConfirm,
  onBatchRetry
}: Props): ReactElement {
  const [state, dispatch] = useReducer(
    reducer,
    initialItems,
    createWorkbenchState
  );
  const [batchStatus, setBatchStatus] = useState<string | null>(null);

  useEffect(() => {
    dispatch({ type: "refresh", items: initialItems });
  }, [initialItems]);

  const overview = useMemo(() => buildStageOverview(state.items), [state.items]);

  const drawerItem = useMemo<ProductPoolItemV1 | null>(() => {
    if (!state.drawerProductId) return null;
    return (
      state.items.find((i) => String(i.productId) === state.drawerProductId) ?? null
    );
  }, [state.drawerProductId, state.items]);

  const progressItem = useMemo<ProductPoolItemV1 | null>(() => {
    if (drawerItem) return drawerItem;
    if (state.selectedIds.size !== 1) return null;
    const selectedId = state.selectedIds.values().next().value as string | undefined;
    return state.items.find((item) => String(item.productId) === selectedId) ?? null;
  }, [drawerItem, state.items, state.selectedIds]);

  const refreshProductPool = useCallback(async () => {
    const result = await fetchProductPool(productFetcher);
    dispatch({ type: "refresh", items: result.items });
  }, [productFetcher]);

  const hasProcessingRows = useMemo(() => {
    return state.items.some((item) => {
      const id = String(item.productId);
      return productStage(item) === "processing" ||
        buildAutomationProgress(item).some((node) => node.state === "running") ||
        state.startStatusById.get(id) === "pending" ||
        state.startStatusById.get(id) === "success";
    });
  }, [state.items, state.startStatusById]);

  useEffect(() => {
    if (refreshIntervalMs === null || !hasProcessingRows) return;
    const interval = window.setInterval(() => {
      void refreshProductPool().catch(() => undefined);
    }, refreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [hasProcessingRows, refreshIntervalMs, refreshProductPool]);

  const startProducts = useCallback(async (productIds: ReadonlyArray<string>) => {
    dispatch({ type: "start-pending", productIds: [...productIds] });
    onStartAutomation?.(productIds);
    await Promise.all(productIds.map(async (productId) => {
      const item = state.items.find((candidate) => String(candidate.productId) === productId);
      if (!item) {
        dispatch({ type: "start-result", productId, result: "failure" });
        return;
      }
      try {
        await dispatchStartAutomation(apiClient, {
          revisionIds: [String(item.currentRevisionId)]
        });
        dispatch({ type: "start-result", productId, result: "success" });
        void refreshProductPool().catch(() => undefined);
      } catch {
        dispatch({ type: "start-result", productId, result: "failure" });
      }
    }));
  }, [apiClient, refreshProductPool, state.items, onStartAutomation]);

  const handleStart = useCallback((productId: string) => {
    void startProducts([productId]);
  }, [startProducts]);

  const handleBatchStart = useCallback(() => {
    const productIds = selectedStartableProductIds(state);
    if (productIds.length === 0) return;
    void startProducts(productIds);
  }, [startProducts, state]);

  const handleBatchConfirm = useCallback(() => {
    const productIds = selectedBatchConfirmIds(state);
    if (productIds.length === 0) return;
    onBatchConfirm?.(productIds);
    setBatchStatus("批量确认写回：正在提交…");
    void dispatchBatchProductAction(batchActionFetcher, { action: "confirm_miaoshou_edit", productIds })
      .then((result) => setBatchStatus(summarizeBatchProductActionResult("批量确认写回", result)))
      .catch(() => setBatchStatus("批量确认写回：提交失败，请稍后重试"));
  }, [batchActionFetcher, onBatchConfirm, state]);

  const handleBatchRetry = useCallback(() => {
    const productIds = selectedBatchRetryIds(state);
    if (productIds.length === 0) return;
    onBatchRetry?.(productIds);
    setBatchStatus("批量重试：正在提交…");
    void dispatchBatchProductAction(batchActionFetcher, { action: "retry_from_failure", productIds })
      .then((result) => setBatchStatus(summarizeBatchProductActionResult("批量重试", result)))
      .catch(() => setBatchStatus("批量重试：提交失败，请稍后重试"));
  }, [batchActionFetcher, onBatchRetry, state]);

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
          onStart={handleStart}
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
          aria-label={state.batchStartLabel}
          disabled={!state.batchStartEnabled}
          onClick={handleBatchStart}
        >
          {state.batchStartLabel}
        </button>
        <button
          type="button"
          aria-label={state.batchConfirmLabel}
          disabled={!state.batchConfirmEnabled}
          onClick={handleBatchConfirm}
        >
          {state.batchConfirmLabel}
        </button>
        <button
          type="button"
          aria-label={state.batchRetryLabel}
          disabled={!state.batchRetryEnabled}
          onClick={handleBatchRetry}
        >
          {state.batchRetryLabel}
        </button>
        {progressItem ? (
          <AutomationProgress
            productId={String(progressItem.productId)}
            nodes={buildAutomationProgress(progressItem)}
          />
        ) : (
          <span className="tk-automation-progress__empty">选择一个商品查看真实进度</span>
        )}
        {batchStatus ? <span className="tk-batch-status" role="status" aria-live="polite">{batchStatus}</span> : null}
      </footer>
    </section>
  );
}
