"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { ImageGenerationViewV1 } from "@tk/contracts/read-models";

export type ImageGenerationCategoryOption = Readonly<{ categoryKey: string; name: string }>;

export type ImageGenerationPanelProps = Readonly<{
  productId: string;
  revisionId: string;
  imageGeneration: ImageGenerationViewV1 | null;
  selectedAssetIds?: ReadonlySet<string>;
  onSelectedAssetIdsChange?: (assetIds: ReadonlySet<string>) => void;
  showInputGallery?: boolean;
  /** Provided by tests or a server parent; otherwise loaded from the existing templates API. */
  categoryOptions?: readonly ImageGenerationCategoryOption[];
}>;

const NOOP_REFRESH = () => {};
const ACTIVE_SLOT_STATES = new Set(["waiting_for_plan", "queued", "running"]);

function newRunIntentId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `intent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function useRefresh(): () => void {
  try {
    return useRouter().refresh;
  } catch {
    return NOOP_REFRESH;
  }
}

function stateLabel(state: ImageGenerationViewV1["state"], successfulCount: number, requestedCount: number): string {
  switch (state) {
    case "not_started": return "等待开始";
    case "planning": return "正在分析商品图片";
    case "generating": return `正在生成 ${successfulCount}/${requestedCount}`;
    case "partial": return `已生成 ${successfulCount}/${requestedCount}`;
    case "succeeded": return `已完成 ${successfulCount}/${requestedCount}`;
    case "failed": return "本批没有可用结果";
  }
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  template_not_found: "该品类还没有启用洗图模板，请先到模板管理中启用。",
  no_active_template_version: "该品类没有可用的启用版本，请先检查模板设置。",
  asset_not_ready: "所选原图尚未保存完成，请刷新后重新选择。",
  asset_not_in_revision: "所选原图不属于当前商品版本，请刷新后重新选择。",
  slot_not_retryable: "这张图片当前不能重试，页面将刷新最新状态。",
  slot_not_excludable: "这张图片已经开始处理，不能再取消。",
  no_successful_slots: "至少需要选择一张成功图片才能确认。",
  same_origin_json_required: "当前页面地址不允许执行此操作，请从本机工作台重新打开。"
};

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : "";
  return ERROR_MESSAGES[code] ?? fallback;
}

function SlotCard({
  slot,
  batchId,
  productId,
  onMessage,
  selectedForFinal,
  onToggleFinal
}: {
  slot: ImageGenerationViewV1["slots"][number];
  batchId: string;
  productId: string;
  onMessage: (message: string, error?: boolean) => void;
  selectedForFinal: boolean;
  onToggleFinal: (slotId: string) => void;
}): ReactElement {
  const [loading, setLoading] = useState(false);
  const refresh = useRefresh();

  async function mutate(action: "retry" | "exclude"): Promise<void> {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/products/${productId}/image-generations/${batchId}/slots/${slot.slotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, batchId, slotId: slot.slotId })
      });
      if (!response.ok) {
        onMessage(await errorMessage(response, action === "retry"
          ? "重新生成未提交，已有成功图片不受影响，请刷新后重试。"
          : "取消操作未完成，请刷新后重试。"), true);
        refresh();
        return;
      }
      onMessage(action === "retry" ? "已提交这张图片的重新生成任务。" : "已取消这张尚未执行的图片。", false);
      refresh();
    } catch {
      onMessage("请求未完成，已经生成的图片不会丢失，请重试。", true);
    } finally {
      setLoading(false);
    }
  }

  const canRetry = slot.status === "failed";
  const canExclude = slot.status === "waiting_for_plan" || slot.status === "queued";

  return (
    <div className="tk-igen-slot-card" data-status={slot.status}>
      <div className="tk-igen-slot-thumb">
        {slot.status === "succeeded" && slot.localUrl
          ? <img src={slot.localUrl} alt={`第 ${slot.slotNumber} 张`} />
          : <div className="tk-igen-slot-empty" aria-label="无图片" />}
      </div>
      <div className="tk-igen-slot-info">
        <span className="tk-igen-slot-num">第 {slot.slotNumber} 张</span>
        <span className="tk-igen-slot-status">{slot.status === "succeeded" ? "成功" : slot.status === "failed" ? "失败" : "处理中"}</span>
        {slot.error && <span className="tk-igen-slot-error">这张图片处理失败，可以单独重试。</span>}
        {slot.status === "succeeded" ? (
          <label className="tk-igen-slot-use">
            <input
              type="checkbox"
              checked={selectedForFinal}
              onChange={() => onToggleFinal(slot.slotId)}
              aria-label={`使用第 ${slot.slotNumber} 张`}
            />
            使用此图
          </label>
        ) : null}
      </div>
      <div className="tk-igen-slot-actions">
        {slot.status === "succeeded" && slot.localUrl && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm" onClick={() => window.open(slot.localUrl!, "_blank")} disabled={loading}>
            放大
          </button>
        )}
        {canRetry && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm" onClick={() => void mutate("retry")} disabled={loading}>
            {loading ? "正在提交…" : "重新生成这张"}
          </button>
        )}
        {canExclude && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm tk-igen-btn--ghost" onClick={() => void mutate("exclude")} disabled={loading}>
            {loading ? "正在取消…" : "取消这张"}
          </button>
        )}
      </div>
    </div>
  );
}

export function ImageGenerationPanel({
  productId,
  revisionId,
  imageGeneration,
  selectedAssetIds: controlledSelectedAssetIds,
  onSelectedAssetIdsChange,
  showInputGallery = true,
  categoryOptions: providedCategoryOptions
}: ImageGenerationPanelProps): ReactElement {
  const refresh = useRefresh();
  const effectiveCategory = imageGeneration?.confirmedCategory ?? imageGeneration?.inferredCategory ?? "";
  const effectiveState = imageGeneration?.state ?? "not_started";
  const isNotStarted = effectiveState === "not_started";
  const batchId = imageGeneration?.batchId ?? null;
  const [outputCount, setOutputCount] = useState(() => imageGeneration?.requestedCount ?? 4);
  const [internalSelectedAssetIds, setInternalSelectedAssetIds] = useState<ReadonlySet<string>>(
    () => new Set(imageGeneration?.selectedInputs.map((input) => String(input.assetId)) ?? [])
  );
  const selectedAssetIds = controlledSelectedAssetIds ?? internalSelectedAssetIds;
  const [selectedCategory, setSelectedCategory] = useState(effectiveCategory);
  const [loadedCategoryOptions, setLoadedCategoryOptions] = useState<readonly ImageGenerationCategoryOption[]>(providedCategoryOptions ?? []);
  const [templatesLoading, setTemplatesLoading] = useState(providedCategoryOptions === undefined && isNotStarted);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingFinalImages, setConfirmingFinalImages] = useState(false);
  const [showNewBatchSetup, setShowNewBatchSetup] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runIntentIdRef = useRef(newRunIntentId());

  const hasInFlightSlots = imageGeneration?.slots.some((slot) => ACTIVE_SLOT_STATES.has(slot.status)) ?? false;
  const successfulSlots = imageGeneration?.slots
    .filter((slot) => slot.status === "succeeded" && slot.localUrl)
    .slice()
    .sort((a, b) => a.slotNumber - b.slotNumber) ?? [];
  const persistedFinalSlotIds = successfulSlots
    .filter((slot) => slot.acceptedOrder !== null)
    .sort((a, b) => (a.acceptedOrder ?? 0) - (b.acceptedOrder ?? 0))
    .map((slot) => slot.slotId);
  const finalOrderProjectionKey = `${batchId ?? "none"}:${successfulSlots.map((slot) => `${slot.slotId}:${slot.acceptedOrder ?? "-"}`).join(",")}`;
  const [orderedFinalSlotIds, setOrderedFinalSlotIds] = useState<string[]>(() =>
    persistedFinalSlotIds.length > 0 ? persistedFinalSlotIds : successfulSlots.map((slot) => slot.slotId)
  );
  const showSetup = isNotStarted || showNewBatchSetup;
  const hasSelectedTemplate = loadedCategoryOptions.some((option) => option.categoryKey === selectedCategory);
  const finalOrderIsPersisted = persistedFinalSlotIds.length > 0
    && persistedFinalSlotIds.join("|") === orderedFinalSlotIds.join("|");

  const stopPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = null;
  }, []);

  useEffect(() => {
    if (providedCategoryOptions !== undefined || !showSetup) return;
    let cancelled = false;
    setTemplatesLoading(true);
    void fetch("/api/v1/image-generation-templates")
      .then(async (response) => {
        if (!response.ok) throw new Error("template_list_failed");
        const body = await response.json() as { items?: Array<{ categoryKey?: unknown; name?: unknown; lifecycleState?: unknown }> };
        if (cancelled) return;
        const options = (body.items ?? []).flatMap((item) =>
          item.lifecycleState === "active" && typeof item.categoryKey === "string"
            ? [{ categoryKey: item.categoryKey, name: typeof item.name === "string" ? item.name : item.categoryKey }]
            : []
        );
        setLoadedCategoryOptions(options);
        setSelectedCategory((current) => current || options[0]?.categoryKey || "");
      })
      .catch(() => {
        if (!cancelled) setMessage({ text: "模板列表加载失败，请刷新后重试。", error: true });
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => { cancelled = true; };
  }, [providedCategoryOptions, showSetup]);

  useEffect(() => {
    setOrderedFinalSlotIds(persistedFinalSlotIds.length > 0
      ? persistedFinalSlotIds
      : successfulSlots.map((slot) => slot.slotId));
    // This projection key changes only when the server batch/result/accepted order changes.
  }, [finalOrderProjectionKey]);

  useEffect(() => {
    if (!hasInFlightSlots) {
      stopPolling();
      return;
    }
    const poll = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
    };
    pollingRef.current ??= setInterval(poll, 3_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
    };
  }, [hasInFlightSlots, refresh, stopPolling]);

  function setActionMessage(text: string, error = false): void {
    setMessage({ text, error });
  }

  async function handleStart(): Promise<void> {
    if (submitting || selectedAssetIds.size < 1 || selectedAssetIds.size > 6 || !hasSelectedTemplate) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/products/${productId}/image-generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisionId,
          categoryKey: selectedCategory,
          selectedAssetIds: Array.from(selectedAssetIds),
          outputCount,
          runIntentId: runIntentIdRef.current
        })
      });
      if (!response.ok) {
        setActionMessage(await errorMessage(response, "洗图任务未启动，原图和已有结果不受影响，请重试。"), true);
        return;
      }
      setActionMessage("洗图任务已提交，页面会自动更新进度。", false);
      refresh();
    } catch {
      setActionMessage("请求未完成，尚不能确认任务是否启动，请刷新检查后再操作。", true);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAsset(assetId: string): void {
    const next = new Set(selectedAssetIds);
    if (next.has(assetId)) next.delete(assetId);
    else if (next.size < 6) next.add(assetId);
    if (onSelectedAssetIdsChange) onSelectedAssetIdsChange(next);
    else setInternalSelectedAssetIds(next);
  }

  function adjustCount(delta: number): void {
    setOutputCount((current) => Math.max(1, Math.min(8, current + delta)));
  }

  function toggleFinalSlot(slotId: string): void {
    setOrderedFinalSlotIds((current) => current.includes(slotId)
      ? current.filter((id) => id !== slotId)
      : [...current, slotId]);
  }

  function moveFinalSlot(slotId: string, delta: -1 | 1): void {
    setOrderedFinalSlotIds((current) => {
      const index = current.indexOf(slotId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function confirmFinalImages(): Promise<void> {
    if (!batchId || orderedFinalSlotIds.length === 0 || confirmingFinalImages || hasInFlightSlots) return;
    setConfirmingFinalImages(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/products/${productId}/image-generations/${batchId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId, orderedSlotIds: orderedFinalSlotIds })
      });
      if (!response.ok) {
        setActionMessage(await errorMessage(response, "最终图片未确认，当前选择仍保留，请重试。"), true);
        return;
      }
      setActionMessage("最终图片顺序已确认，妙手审核将使用这个顺序。", false);
      refresh();
    } catch {
      setActionMessage("请求未完成，当前选择仍保留，请刷新确认后再操作。", true);
    } finally {
      setConfirmingFinalImages(false);
    }
  }

  const showSlots = Boolean(imageGeneration && batchId && imageGeneration.slots.length > 0);
  const canStart = selectedAssetIds.size >= 1 && selectedAssetIds.size <= 6 && hasSelectedTemplate && !submitting;

  return (
    <section aria-label="图片生成" className="tk-panel tk-igen-panel">
      <header className="tk-igen-panel__header">
        <div>
          <p>智能洗图</p>
          <h2>{stateLabel(effectiveState, imageGeneration?.successfulCount ?? 0, outputCount)}</h2>
        </div>
      </header>

      {showSetup && (
        <>
          <div className="tk-igen-category-row">
            <label className="tk-igen-label" htmlFor={`image-category-${productId}`}>品类</label>
            {templatesLoading ? <span className="tk-igen-category">正在加载模板…</span> : (
              <select
                id={`image-category-${productId}`}
                className="tk-igen-category"
                aria-label="洗图品类"
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
              >
                <option value="" disabled>请选择品类</option>
                {loadedCategoryOptions.map((option) => (
                  <option key={option.categoryKey} value={option.categoryKey}>{option.name}</option>
                ))}
              </select>
            )}
            {loadedCategoryOptions.length === 0 && !templatesLoading ? <a href="/templates">前往模板管理</a> : null}
          </div>

          {showInputGallery && <div className="tk-igen-thumb-grid" aria-label="选择原图">
            {imageGeneration?.availableInputs.map((input) => (
              <button
                key={input.assetId}
                type="button"
                className={`tk-igen-thumb ${selectedAssetIds.has(input.assetId) ? "is-selected" : ""}`}
                onClick={() => toggleAsset(String(input.assetId))}
                aria-label={`选择图片 ${input.assetId}`}
                aria-pressed={selectedAssetIds.has(input.assetId)}
              >
                <img src={input.localUrl} alt={input.role ?? "商品图片"} />
                {selectedAssetIds.has(input.assetId) && <span className="tk-igen-thumb-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>}

          <div className="tk-igen-count-row">
            <span className="tk-igen-label">已选原图</span>
            <strong>{selectedAssetIds.size}/6</strong>
            <span className="tk-igen-label" aria-label="输出数量">输出数量</span>
            <div className="tk-igen-count-controls">
              <button type="button" className="tk-igen-btn tk-igen-btn--icon" onClick={() => adjustCount(-1)} aria-label="减少" disabled={outputCount <= 1}>−</button>
              <span className="tk-igen-count" aria-live="polite">{outputCount}</span>
              <button type="button" className="tk-igen-btn tk-igen-btn--icon" onClick={() => adjustCount(1)} aria-label="增加" disabled={outputCount >= 8}>+</button>
            </div>
          </div>

          <button type="button" className="tk-igen-btn tk-igen-btn--primary tk-igen-btn--block" onClick={() => void handleStart()} disabled={!canStart}>
            {submitting ? "正在启动…" : showNewBatchSetup ? "开始新一批洗图" : "开始洗图"}
          </button>
        </>
      )}

      {showSlots && imageGeneration && batchId ? (
        <div className="tk-igen-slots-grid">
          {imageGeneration.slots.slice().sort((a, b) => a.slotNumber - b.slotNumber).map((slot) => (
            <SlotCard
              key={slot.slotId}
              slot={slot}
              batchId={batchId}
              productId={productId}
              onMessage={setActionMessage}
              selectedForFinal={orderedFinalSlotIds.includes(slot.slotId)}
              onToggleFinal={toggleFinalSlot}
            />
          ))}
        </div>
      ) : null}

      {showSlots && successfulSlots.length > 0 ? (
        <section className="tk-igen-final-order" aria-label="确认最终图片">
          <header>
            <div>
              <strong>最终图片顺序</strong>
              <p>第一张作为主图，不需要拖拽。</p>
            </div>
            {finalOrderIsPersisted ? <span className="tk-igen-confirmed">已确认最终图片顺序</span> : null}
          </header>
          <ol>
            {orderedFinalSlotIds.map((slotId, index) => {
              const slot = successfulSlots.find((candidate) => candidate.slotId === slotId);
              if (!slot) return null;
              return (
                <li key={slotId}>
                  <img src={slot.localUrl!} alt={`最终顺序第 ${index + 1} 张`} />
                  <span>{index === 0 ? `主图 · 第 ${slot.slotNumber} 张` : `第 ${index + 1} 位 · 第 ${slot.slotNumber} 张`}</span>
                  <div>
                    <button type="button" className="tk-igen-btn tk-igen-btn--sm" aria-label={`第 ${slot.slotNumber} 张左移`} onClick={() => moveFinalSlot(slotId, -1)} disabled={index === 0}>左移</button>
                    <button type="button" className="tk-igen-btn tk-igen-btn--sm" aria-label={`第 ${slot.slotNumber} 张右移`} onClick={() => moveFinalSlot(slotId, 1)} disabled={index === orderedFinalSlotIds.length - 1}>右移</button>
                  </div>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="tk-igen-btn tk-igen-btn--primary"
            onClick={() => void confirmFinalImages()}
            disabled={orderedFinalSlotIds.length === 0 || confirmingFinalImages || hasInFlightSlots || finalOrderIsPersisted}
          >
            {confirmingFinalImages ? "正在确认…" : `确认使用这 ${orderedFinalSlotIds.length} 张图片`}
          </button>
          {orderedFinalSlotIds.length === 0 ? <p className="tk-igen-final-hint">请至少勾选一张成功图片。</p> : null}
          {hasInFlightSlots ? <p className="tk-igen-final-hint">仍有图片处理中，完成后即可确认最终顺序。</p> : null}
        </section>
      ) : null}

      {!isNotStarted && !hasInFlightSlots ? (
        <div className="tk-igen-terminal" aria-live="polite">
          <p>{effectiveState === "succeeded" ? "洗图完成，请在下方确认最终图片。" : "本批处理已结束，已有成功图片不会丢失。"}</p>
          {!showNewBatchSetup ? (
            <button
              type="button"
              className="tk-igen-btn tk-igen-btn--ghost"
              onClick={() => {
                runIntentIdRef.current = newRunIntentId();
                setMessage(null);
                setShowNewBatchSetup(true);
              }}
            >
              调整参数新建一批
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p className={message.error ? "tk-igen-message is-error" : "tk-igen-message"} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
