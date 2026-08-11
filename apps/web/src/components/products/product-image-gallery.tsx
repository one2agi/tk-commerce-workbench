"use client";

import {
  useRef,
  useState,
  type ReactElement
} from "react";

import { ImagePreviewDialog } from "./image-preview-dialog";

export type ProductImageGalleryProps = Readonly<{
  productId: string;
  originalImageUrls: readonly string[];
  processedImageUrls: readonly string[];
}>;

type GalleryKind = "original" | "processed";
type PreviewState = Readonly<{
  kind: GalleryKind;
  activeIndex: number;
}> | null;

type ImageSectionProps = Readonly<{
  productId: string;
  kind: GalleryKind;
  images: readonly string[];
  failedImageKeys: ReadonlySet<string>;
  onImageFailure: (key: string) => void;
  onOpen: (kind: GalleryKind, index: number, opener: HTMLButtonElement) => void;
}>;

const KIND_LABEL: Readonly<Record<GalleryKind, "原产品图" | "洗图后的图">> = {
  original: "原产品图",
  processed: "洗图后的图"
};

function ImageSection({
  productId,
  kind,
  images,
  failedImageKeys,
  onImageFailure,
  onOpen
}: ImageSectionProps): ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const label = KIND_LABEL[kind];
  const emptyLabel = kind === "original" ? "未采集到可用原图" : "等待生成";

  function scrollBy(left: number): void {
    scrollerRef.current?.scrollBy({ left, behavior: "smooth" });
  }

  return (
    <section
      className={`tk-product-image-gallery__section is-${kind}`}
      role="region"
      aria-label={`商品 ${productId} ${label}`}
    >
      <header className="tk-product-image-gallery__label">
        <div>
          <h2>{label}</h2><span>{images.length}</span>
        </div>
        <p>{kind === "original" ? "采集完成即展示" : "Canvas 生成后自动补充"}</p>
      </header>
      {images.length > 0 ? (
        <>
          <div ref={scrollerRef} className="tk-product-image-gallery__scroller">
            <div className="tk-product-image-gallery__strip">
              {images.map((url, index) => {
                const failedKey = `${kind}:${index}:${url}`;
                const failed = failedImageKeys.has(failedKey);
                return (
                  <button
                    key={failedKey}
                    type="button"
                    className="tk-product-image-gallery__tile"
                    aria-label={`放大${label} ${index + 1}/${images.length}`}
                    onClick={(event) => onOpen(kind, index, event.currentTarget)}
                  >
                    {index === 0 ? (
                      <span className="tk-product-image-gallery__badge-cover">主图</span>
                    ) : null}
                    {failed ? (
                      <span>图片加载失败</span>
                    ) : (
                      <img
                        src={url}
                        alt={`${label} ${index + 1}`}
                        loading="lazy"
                        onError={() => onImageFailure(failedKey)}
                      />
                    )}
                    <small>{index + 1}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="tk-product-image-gallery__controls">
            <button type="button" aria-label={`${label}向左滚动`} onClick={() => scrollBy(-320)}>
              ‹
            </button>
            <button type="button" aria-label={`${label}向右滚动`} onClick={() => scrollBy(320)}>
              ›
            </button>
          </div>
        </>
      ) : (
        <div className="tk-product-image-gallery__empty">{emptyLabel}</div>
      )}
    </section>
  );
}

export function ProductImageGallery({
  productId,
  originalImageUrls,
  processedImageUrls
}: ProductImageGalleryProps): ReactElement {
  const [preview, setPreview] = useState<PreviewState>(null);
  const [failedImageKeys, setFailedImageKeys] = useState<ReadonlySet<string>>(new Set());
  const openerRef = useRef<HTMLButtonElement | null>(null);

  function handleOpen(
    kind: GalleryKind,
    activeIndex: number,
    opener: HTMLButtonElement
  ): void {
    openerRef.current = opener;
    setPreview({ kind, activeIndex });
  }

  function handleClose(): void {
    setPreview(null);
    openerRef.current?.focus();
  }

  function handleImageFailure(key: string): void {
    setFailedImageKeys((current) => new Set(current).add(key));
  }

  return (
    <div className="tk-product-image-gallery">
      <ImageSection
        productId={productId}
        kind="original"
        images={originalImageUrls}
        failedImageKeys={failedImageKeys}
        onImageFailure={handleImageFailure}
        onOpen={handleOpen}
      />
      <ImageSection
        productId={productId}
        kind="processed"
        images={processedImageUrls}
        failedImageKeys={failedImageKeys}
        onImageFailure={handleImageFailure}
        onOpen={handleOpen}
      />
      {preview ? (
        <ImagePreviewDialog
          kind={KIND_LABEL[preview.kind]}
          originalImageUrls={originalImageUrls}
          processedImageUrls={processedImageUrls}
          activeIndex={preview.activeIndex}
          onActiveIndexChange={(activeIndex) => setPreview({ ...preview, activeIndex })}
          onClose={handleClose}
        />
      ) : null}
    </div>
  );
}
