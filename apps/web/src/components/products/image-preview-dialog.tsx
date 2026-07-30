"use client";

import { useEffect, useRef, type MouseEvent, type ReactElement } from "react";

export type ImagePreviewDialogProps = Readonly<{
  kind: "原产品图" | "洗图后的图";
  images: readonly string[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
}>;

export function ImagePreviewDialog({
  kind,
  images,
  activeIndex,
  onActiveIndexChange,
  onClose
}: ImagePreviewDialogProps): ReactElement | null {
  const closeRef = useRef<HTMLButtonElement>(null);
  const activeImage = images[activeIndex];

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
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onActiveIndexChange((activeIndex - 1 + images.length) % images.length);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onActiveIndexChange((activeIndex + 1) % images.length);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, images.length, onActiveIndexChange, onClose]);

  if (!activeImage) return null;

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="tk-image-preview__backdrop" onMouseDown={handleBackdropClick}>
      <section
        className="tk-image-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`${kind}预览`}
      >
        <header className="tk-image-preview__header">
          <div>
            <span className="tk-image-preview__kind">{kind}</span>
            <strong>{activeIndex + 1} / {images.length}</strong>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭图片预览">
            ×
          </button>
        </header>
        <div className="tk-image-preview__stage">
          <button
            type="button"
            className="tk-image-preview__previous"
            aria-label="上一张"
            onClick={() => onActiveIndexChange((activeIndex - 1 + images.length) % images.length)}
          >
            ‹
          </button>
          <img src={activeImage} alt={`${kind} ${activeIndex + 1}`} />
          <button
            type="button"
            className="tk-image-preview__next"
            aria-label="下一张"
            onClick={() => onActiveIndexChange((activeIndex + 1) % images.length)}
          >
            ›
          </button>
        </div>
        <div className="tk-image-preview__filmstrip" aria-label={`${kind}缩略图导航`}>
          {images.map((url, index) => (
            <button
              key={`${url}:${index}`}
              type="button"
              className={index === activeIndex ? "is-active" : undefined}
              aria-label={`查看${kind} ${index + 1}/${images.length}`}
              onClick={() => onActiveIndexChange(index)}
            >
              <img src={url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
