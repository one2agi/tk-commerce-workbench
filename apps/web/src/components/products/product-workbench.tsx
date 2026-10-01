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
  canStartAutomation,
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

  const hasSelection = state.selectedIds.size > 0;
  const showFooter = hasSelection || Boolean(batchStatus);

  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");

  const displayFiltered = useMemo(() => {
    let list = state.filtered;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((item) => {
        const title = (item.targetTitle ?? item.canonicalSourceTitle ?? String(item.productId)).toLowerCase();
        return title.includes(q) || String(item.productId).includes(q) || (item.sourceItemId && String(item.sourceItemId).includes(q));
      });
    }
    if (sourceFilter !== "all") {
      list = list.filter((item) => {
        if (sourceFilter === "1688") {
          return Boolean(item.sourceUrl?.includes("1688"));
        }
        return true;
      });
    }
    return list;
  }, [state.filtered, searchQuery, sourceFilter]);

  const handleBatchConfirmReview = useCallback(() => {
    const selectedConfirmIds = selectedBatchConfirmIds(state);
    const productIds = selectedConfirmIds.length > 0
      ? selectedConfirmIds
      : state.items.filter((item) => productStage(item) === "review").map((item) => String(item.productId));
    if (productIds.length === 0) return;
    onBatchConfirm?.(productIds);
    setBatchStatus("批量确认写回：正在提交…");
    void dispatchBatchProductAction(batchActionFetcher, { action: "confirm_miaoshou_edit", productIds })
      .then((result) => setBatchStatus(summarizeBatchProductActionResult("批量确认写回", result)))
      .catch(() => setBatchStatus("批量确认写回：提交失败，请稍后重试"));
  }, [batchActionFetcher, onBatchConfirm, state]);

  const handleBatchStartPending = useCallback(() => {
    const selectedStartIds = selectedStartableProductIds(state);
    const productIds = selectedStartIds.length > 0
      ? selectedStartIds
      : state.items.filter((item) => canStartAutomation(item)).map((item) => String(item.productId));
    if (productIds.length === 0) return;
    void startProducts(productIds);
  }, [startProducts, state]);

  return (
    <section className="tk-product-workbench" aria-label="商品工作台">
      {/* 1. 顶部标题与业务上下文 */}
      <div className="tk-workbench-header">
        <h1 className="tk-workbench-title">商品处理台</h1>
        <div className="tk-context-bar">
          <div className="tk-context-pill">
            <span className="tk-context-pill__icon" aria-hidden="true">🌿</span>
            <span className="tk-context-pill__text">TikTok 东南亚 · 默认泰国站 · 妙手未发布 · 跑图5张</span>
          </div>
          <a href="/processing-rules" className="tk-context-link">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>上架与自动化</span>
          </a>
        </div>
      </div>

      {/* 2. 搜索与筛选工具栏 */}
      <div className="tk-filter-toolbar">
        <div className="tk-search-box">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索商品标题"
            className="tk-search-input"
            aria-label="搜索商品标题"
          />
        </div>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="tk-select-source"
          aria-label="来源筛选"
        >
          <option value="all">全部来源</option>
          <option value="1688">1688</option>
        </select>
        <button type="button" className="tk-btn-subtle" onClick={refreshProductPool} title="刷新采集">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          <span>检查新采集</span>
        </button>
      </div>

      {/* 3. 阶段 Tab + 头部快捷行动区 */}
      <div className="tk-tabs-action-row">
        <StageOverview
          overview={overview}
          activeStage={state.activeStage}
          onSelect={(stage) => dispatch({ type: "stage", stage })}
        />
        <div className="tk-tabs-action-buttons">
          <button
            type="button"
            className="tk-btn-outline-blue"
            disabled={overview.pending.count === 0 && !state.batchStartEnabled}
            onClick={handleBatchStartPending}
          >
            <span aria-hidden="true">🔄</span>
            <span>补图 / 批量处理</span>
          </button>
          <button
            type="button"
            className="tk-btn-solid-green"
            disabled={overview.review.count === 0 && !state.batchConfirmEnabled}
            onClick={handleBatchConfirmReview}
          >
            <span aria-hidden="true">🍵</span>
            <span>写入妙手未发布 {overview.review.count}</span>
          </button>
        </div>
      </div>

      {/* 4. 商品核心列表表格 */}
      <div className="tk-product-workbench__body">
        <ProductTable
          items={state.items}
          filtered={displayFiltered}
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

      {/* 5. 底部信息与分页栏 */}
      <div className="tk-workbench-footer-bar">
        <div className="tk-footer-summary">
          <span>当前待处理 <strong>{displayFiltered.length}</strong> 条</span>
          <span className="tk-footer-bullet">·</span>
          <span>已写入 <strong>{overview.synced.count}</strong> 条，<a href="/write-records">见写入记录</a></span>
          <span className="tk-footer-bullet">·</span>
          <span>本页 1-{displayFiltered.length}</span>
        </div>
        <div className="tk-footer-pagination">
          <span className="tk-page-size-label">每页</span>
          <select className="tk-page-size-select" defaultValue="50" aria-label="每页显示条数">
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
          <div className="tk-pagination-control">
            <button type="button" className="tk-pagination-nav-btn" disabled aria-label="上一页">‹</button>
            <span className="tk-pagination-page">1 / 1</span>
            <button type="button" className="tk-pagination-nav-btn" disabled aria-label="下一页">›</button>
          </div>
        </div>
      </div>

      {/* 浮动批量操作条 (选择多项时浮现) */}
      <footer
        className={`tk-product-workbench__footer ${showFooter ? "is-visible" : "is-hidden"}`}
        data-has-selection={hasSelection}
      >
        <div className="tk-product-workbench__batch-actions">
          <button
            type="button"
            className="tk-btn-batch-primary"
            aria-label={state.batchStartLabel}
            disabled={!state.batchStartEnabled}
            onClick={handleBatchStart}
          >
            {state.batchStartLabel}
          </button>
          <button
            type="button"
            className="tk-btn-batch-action"
            aria-label={state.batchConfirmLabel}
            disabled={!state.batchConfirmEnabled}
            onClick={handleBatchConfirm}
          >
            {state.batchConfirmLabel}
          </button>
          <button
            type="button"
            className="tk-btn-batch-action"
            aria-label={state.batchRetryLabel}
            disabled={!state.batchRetryEnabled}
            onClick={handleBatchRetry}
          >
            {state.batchRetryLabel}
          </button>
        </div>
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
