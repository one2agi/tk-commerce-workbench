"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { ImageGenerationViewV1 } from "@tk/contracts/read-models";

export type ImageGenerationPanelProps = Readonly<{
  productId: string;
  revisionId: string;
  imageGeneration: ImageGenerationViewV1 | null;
  selectedAssetIds?: ReadonlySet<string>;
  onSelectedAssetIdsChange?: (assetIds: ReadonlySet<string>) => void;
  showInputGallery?: boolean;
}>;

// Stable no-op for server-side rendering where useRouter is unavailable
const NOOP_REFRESH = () => {};

function useRefresh(): () => void {
  try {
    const router = useRouter();
    return router.refresh;
  } catch {
    return NOOP_REFRESH;
  }
}

type PanelMode = "idle" | "executing";

function stateLabel(state: ImageGenerationViewV1["state"], successfulCount: number, requestedCount: number): string {
  switch (state) {
    case "not_started": return "等待开始";
    case "planning": return "正在分析商品图片";
    case "generating": return `正在准备 ${requestedCount} 张图片`;
    case "partial": return `已生成 ${successfulCount}/${requestedCount}`;
    case "succeeded": return `已完成 ${successfulCount}/${requestedCount}，可使用当前结果`;
    case "failed": return "生成失败，请重试";
    default: return "";
  }
}

function SlotCard({
  slot,
  batchId,
  productId,
  onDone
}: {
  slot: ImageGenerationViewV1["slots"][number];
  batchId: string;
  productId: string;
  onDone: () => void;
}): ReactElement {
  const [loading, setLoading] = useState(false);
  const refresh = useRefresh();

  async function handleRetry() {
    setLoading(true);
    try {
      await fetch(`/api/v1/products/${productId}/image-generations/${batchId}/slots/${slot.slotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", batchId, slotId: slot.slotId })
      });
      refresh();
      onDone();
    } finally {
      setLoading(false);
    }
  }

  async function handleExclude() {
    setLoading(true);
    try {
      await fetch(`/api/v1/products/${productId}/image-generations/${batchId}/slots/${slot.slotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exclude", batchId, slotId: slot.slotId })
      });
      refresh();
      onDone();
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
        {slot.error && <span className="tk-igen-slot-error">{slot.error}</span>}
      </div>
      <div className="tk-igen-slot-actions">
        {slot.status === "succeeded" && slot.localUrl && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm" onClick={() => window.open(slot.localUrl!, "_blank")} disabled={loading}>
            放大
          </button>
        )}
        {canRetry && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm" onClick={handleRetry} disabled={loading}>
            重新生成这张
          </button>
        )}
        {canExclude && (
          <button type="button" className="tk-igen-btn tk-igen-btn--sm tk-igen-btn--ghost" onClick={handleExclude} disabled={loading}>
            排除这张
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
  showInputGallery = true
}: ImageGenerationPanelProps): ReactElement {
  const refresh = useRefresh();
  const [mode, setMode] = useState<PanelMode>("idle");
  const [outputCount, setOutputCount] = useState<number>(() => {
    if (!imageGeneration) return 4;
    return imageGeneration.requestedCount;
  });
  const [internalSelectedAssetIds, setInternalSelectedAssetIds] = useState<ReadonlySet<string>>(() => {
    if (!imageGeneration) return new Set();
    return new Set(imageGeneration.selectedInputs.map((i) => i.assetId));
  });
  const selectedAssetIds = controlledSelectedAssetIds ?? internalSelectedAssetIds;
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);

  // Use batchId from the projection
  const batchId = imageGeneration?.batchId ?? null;

  const effectiveCategory = imageGeneration?.confirmedCategory ?? imageGeneration?.inferredCategory ?? "";
  const effectiveState = imageGeneration?.state ?? "not_started";
  const isTerminal = effectiveState === "succeeded" || effectiveState === "failed";
  const hasActiveSlots = imageGeneration?.slots.some(
    (s) => s.status !== "succeeded" && s.status !== "excluded"
  ) ?? false;

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => {
      if (unmountedRef.current) {
        if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        return;
      }
      refresh();
    }, 3000);
  }, [refresh]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; stopPolling(); };
  }, [stopPolling]);

  useEffect(() => {
    if (mode === "executing" && !isTerminal) {
      startPolling();
    } else {
      stopPolling();
    }
  }, [mode, isTerminal, startPolling, stopPolling]);

  async function handleStart() {
    if (selectedAssetIds.size === 0 || selectedAssetIds.size > 6) return;
    setMode("executing");
    try {
      const res = await fetch(`/api/v1/products/${productId}/image-generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisionId,
          categoryKey: effectiveCategory,
          selectedAssetIds: Array.from(selectedAssetIds),
          outputCount
        })
      });
      if (!res.ok) throw new Error("start_failed");
      refresh();
    } catch {
      setMode("idle");
    }
  }

  function toggleAsset(assetId: string) {
    const next = new Set(selectedAssetIds);
    if (next.has(assetId)) next.delete(assetId);
    else if (next.size < 6) next.add(assetId);
    if (onSelectedAssetIdsChange) onSelectedAssetIdsChange(next);
    else setInternalSelectedAssetIds(next);
  }

  function adjustCount(delta: number) {
    setOutputCount((prev) => Math.max(1, Math.min(8, prev + delta)));
  }

  const isNotStarted = effectiveState === "not_started";
  const isExecuting = mode === "executing" || (!isNotStarted && hasActiveSlots);

  return (
    <section aria-label="图片生成" className="tk-panel tk-igen-panel">
      <header className="tk-igen-panel__header">
        <div>
          <p>智能洗图</p>
          <h2>{stateLabel(effectiveState, imageGeneration?.successfulCount ?? 0, outputCount)}</h2>
        </div>
        {!isNotStarted && batchId && (
          <span className="tk-igen-batch-id" aria-label="批次ID">{batchId}</span>
        )}
      </header>

      {isNotStarted && (
        <>
          <div className="tk-igen-category-row">
            <span className="tk-igen-label">品类</span>
            <span className="tk-igen-category">{effectiveCategory || "未识别"}</span>
            <button
              type="button"
              className="tk-igen-btn tk-igen-btn--ghost tk-igen-btn--sm"
              onClick={() => {/* future: open category picker */}}
              aria-label="更改品类"
            >
              更改
            </button>
          </div>

          {showInputGallery && <div className="tk-igen-thumb-grid" aria-label="选择原图">
            {imageGeneration?.availableInputs.map((input) => (
              <button
                key={input.assetId}
                type="button"
                className={`tk-igen-thumb ${selectedAssetIds.has(input.assetId) ? "is-selected" : ""}`}
                onClick={() => toggleAsset(input.assetId)}
                aria-label={`选择图片 ${input.assetId}`}
                aria-pressed={selectedAssetIds.has(input.assetId)}
              >
                <img src={input.localUrl} alt={input.role ?? "商品图片"} />
                {selectedAssetIds.has(input.assetId) && (
                  <span className="tk-igen-thumb-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}
          </div>}

          <div className="tk-igen-count-row">
            <span className="tk-igen-label" aria-label="输出数量">输出数量</span>
            <div className="tk-igen-count-controls">
              <button
                type="button"
                className="tk-igen-btn tk-igen-btn--icon"
                onClick={() => adjustCount(-1)}
                aria-label="减少"
                disabled={outputCount <= 1}
              >−</button>
              <span className="tk-igen-count" aria-live="polite">{outputCount}</span>
              <button
                type="button"
                className="tk-igen-btn tk-igen-btn--icon"
                onClick={() => adjustCount(1)}
                aria-label="增加"
                disabled={outputCount >= 8}
              >+</button>
            </div>
          </div>

          <button
            type="button"
            className="tk-igen-btn tk-igen-btn--primary tk-igen-btn--block"
            onClick={handleStart}
            disabled={selectedAssetIds.size < 1 || selectedAssetIds.size > 6}
          >
            开始洗图
          </button>
        </>
      )}

      {isExecuting && imageGeneration && (
        <>
          <div className="tk-igen-slots-grid">
            {imageGeneration.slots
              .slice()
              .sort((a, b) => a.slotNumber - b.slotNumber)
              .map((slot) => (
                <SlotCard
                  key={slot.slotId}
                  slot={slot}
                  batchId={batchId!}
                  productId={productId}
                  onDone={() => {}}
                />
              ))}
          </div>
        </>
      )}

      {!isNotStarted && !hasActiveSlots && (
        <div className="tk-igen-terminal" aria-live="polite">
          <p>{effectiveState === "succeeded" ? "生成完成" : "生成已结束"}</p>
          <button
            type="button"
            className="tk-igen-btn"
            onClick={() => setMode("idle")}
          >
            重新开始
          </button>
        </div>
      )}
    </section>
  );
}
