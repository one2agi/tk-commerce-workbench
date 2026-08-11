"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";

export type PreviewMode = "single" | "ab";

export type ImagePreviewDialogProps = Readonly<{
  kind: "原产品图" | "洗图后的图";
  originalImageUrls: readonly string[];
  processedImageUrls: readonly string[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
}>;

export function ImagePreviewDialog({
  kind,
  originalImageUrls,
  processedImageUrls,
  activeIndex,
  onActiveIndexChange,
  onClose
}: ImagePreviewDialogProps): ReactElement | null {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<PreviewMode>("single");

  const singleImages = kind === "原产品图" ? originalImageUrls : processedImageUrls;
  const totalLength = mode === "single"
    ? singleImages.length
    : Math.max(originalImageUrls.length, processedImageUrls.length);

  const safeIndex = totalLength > 0 ? Math.min(Math.max(0, activeIndex), totalLength - 1) : 0;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (totalLength === 0) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onActiveIndexChange((safeIndex - 1 + totalLength) % totalLength);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onActiveIndexChange((safeIndex + 1) % totalLength);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [safeIndex, totalLength, onActiveIndexChange, onClose]);

  if (totalLength === 0) return null;

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  const singleImage = singleImages[safeIndex];
  const rawImage = originalImageUrls[safeIndex];
  const washedImage = processedImageUrls[safeIndex];

  const filmstripItems = mode === "single"
    ? singleImages
    : Array.from({ length: totalLength }, (_, i) => processedImageUrls[i] || originalImageUrls[i] || "");

  return (
    <div className="tk-image-preview__backdrop" onMouseDown={handleBackdropClick}>
      <section
        className="tk-image-preview"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "ab" ? "AB对比图片预览" : `${kind}预览`}
      >
        <header className="tk-image-preview__header">
          <div>
            <span className="tk-image-preview__kind">
              {mode === "ab" ? "AB对比" : kind}
            </span>
            <div className="tk-image-preview__mode-toggle" role="tablist" aria-label="预览模式">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "single"}
                className={mode === "single" ? "is-active" : undefined}
                onClick={() => setMode("single")}
              >
                单图模式
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "ab"}
                className={mode === "ab" ? "is-active" : undefined}
                onClick={() => setMode("ab")}
              >
                AB对比模式
              </button>
            </div>
            <strong>{safeIndex + 1} / {totalLength}</strong>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭图片预览">
            ×
          </button>
        </header>
        <div className={`tk-image-preview__stage ${mode === "ab" ? "tk-image-preview__stage--ab" : ""}`}>
          <button
            type="button"
            className="tk-image-preview__previous"
            aria-label="上一张"
            onClick={() => onActiveIndexChange((safeIndex - 1 + totalLength) % totalLength)}
          >
            ‹
          </button>
          {mode === "single" ? (
            singleImage ? (
              <img src={singleImage} alt={`${kind} ${safeIndex + 1}`} />
            ) : (
              <div className="tk-image-preview__placeholder">暂无图片</div>
            )
          ) : (
            <>
              <div className="tk-image-preview__ab-pane">
                <span className="tk-image-preview__ab-tag">原产品图</span>
                {rawImage ? (
                  <img src={rawImage} alt={`原产品图 ${safeIndex + 1}`} />
                ) : (
                  <div className="tk-image-preview__placeholder">无对应原图</div>
                )}
              </div>
              <div className="tk-image-preview__ab-pane">
                <span className="tk-image-preview__ab-tag">洗图后的图</span>
                {washedImage ? (
                  <img src={washedImage} alt={`洗图后的图 ${safeIndex + 1}`} />
                ) : (
                  <div className="tk-image-preview__placeholder">该索引无洗图结果</div>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            className="tk-image-preview__next"
            aria-label="下一张"
            onClick={() => onActiveIndexChange((safeIndex + 1) % totalLength)}
          >
            ›
          </button>
        </div>
        <div className="tk-image-preview__filmstrip" aria-label={`${mode === "ab" ? "AB对比" : kind}缩略图导航`}>
          {filmstripItems.map((url, index) => (
            <button
              key={`${url}:${index}`}
              type="button"
              className={index === safeIndex ? "is-active" : undefined}
              aria-label={`查看${mode === "ab" ? "对比图" : kind} ${index + 1}/${totalLength}`}
              onClick={() => onActiveIndexChange(index)}
            >
              {url ? (
                <img src={url} alt="" loading="lazy" />
              ) : (
                <span className="tk-image-preview__filmstrip-placeholder">{index + 1}</span>
              )}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
