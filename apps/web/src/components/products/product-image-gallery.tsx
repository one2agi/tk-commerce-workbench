"use client";

import { useRef, useState, type ReactElement } from "react";

import { ImagePreviewDialog } from "./image-preview-dialog";

export type ProductGalleryImage = Readonly<{
  key: string;
  url: string;
  assetId: string | null;
  selectable: boolean;
}>;

export type ProductImageGalleryProps = Readonly<{
  productId: string;
  originalImages: readonly ProductGalleryImage[];
  processedImages: readonly ProductGalleryImage[];
  selectedOriginalAssetIds?: ReadonlySet<string>;
  onToggleOriginal?: (assetId: string) => void;
}>;

type GalleryKind = "original" | "processed";
type PreviewState = Readonly<{
  kind: GalleryKind;
  activeIndex: number;
}> | null;

type ImageSectionProps = Readonly<{
  productId: string;
  kind: GalleryKind;
  images: readonly ProductGalleryImage[];
  failedImageKeys: ReadonlySet<string>;
  selectedOriginalAssetIds: ReadonlySet<string>;
  onToggleOriginal?: (assetId: string) => void;
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
  selectedOriginalAssetIds,
  onToggleOriginal,
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
        <p>{kind === "original" ? "采集完成即展示" : "洗图完成后自动展示"}</p>
      </header>
      {images.length > 0 ? (
        <>
          <div ref={scrollerRef} className="tk-product-image-gallery__scroller">
            <div className="tk-product-image-gallery__strip">
              {images.map((image, index) => {
                const failedKey = `${kind}:${image.key}:${image.url}`;
                const failed = failedImageKeys.has(failedKey);
                const canSelect = kind === "original" && image.selectable && image.assetId !== null && onToggleOriginal;
                return (
                  <div key={failedKey} className="tk-product-image-gallery__tile">
                    <button
                      type="button"
                      className="tk-product-image-gallery__preview"
                      aria-label={`放大${label} ${index + 1}/${images.length}`}
                      onClick={(event) => onOpen(kind, index, event.currentTarget)}
                    >
                      {failed ? (
                        <span>图片加载失败</span>
                      ) : (
                        <img
                          src={image.url}
                          alt={`${label} ${index + 1}`}
                          loading="lazy"
                          onError={() => onImageFailure(failedKey)}
                        />
                      )}
                      <small>{index + 1}</small>
                    </button>
                    {kind === "original" ? (
                      canSelect ? (
                        <label className="tk-product-image-gallery__select">
                          <input
                            type="checkbox"
                            checked={selectedOriginalAssetIds.has(image.assetId!)}
                            aria-label={`选作洗图输入 ${label} ${index + 1}`}
                            onChange={() => onToggleOriginal(image.assetId!)}
                          />
                          <span>用于洗图</span>
                        </label>
                      ) : (
                        <span className="tk-product-image-gallery__unavailable">尚未保存完成</span>
                      )
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="tk-product-image-gallery__controls">
            <button type="button" aria-label={`${label}向左滚动`} onClick={() => scrollBy(-320)}>‹</button>
            <button type="button" aria-label={`${label}向右滚动`} onClick={() => scrollBy(320)}>›</button>
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
  originalImages,
  processedImages,
  selectedOriginalAssetIds = new Set(),
  onToggleOriginal
}: ProductImageGalleryProps): ReactElement {
  const [preview, setPreview] = useState<PreviewState>(null);
  const [failedImageKeys, setFailedImageKeys] = useState<ReadonlySet<string>>(new Set());
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const previewImages = preview?.kind === "original"
    ? originalImages.map((image) => image.url)
    : preview?.kind === "processed"
      ? processedImages.map((image) => image.url)
      : [];

  function handleOpen(kind: GalleryKind, activeIndex: number, opener: HTMLButtonElement): void {
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
        images={originalImages}
        failedImageKeys={failedImageKeys}
        selectedOriginalAssetIds={selectedOriginalAssetIds}
        onToggleOriginal={onToggleOriginal}
        onImageFailure={handleImageFailure}
        onOpen={handleOpen}
      />
      <ImageSection
        productId={productId}
        kind="processed"
        images={processedImages}
        failedImageKeys={failedImageKeys}
        selectedOriginalAssetIds={selectedOriginalAssetIds}
        onImageFailure={handleImageFailure}
        onOpen={handleOpen}
      />
      {preview ? (
        <ImagePreviewDialog
          kind={KIND_LABEL[preview.kind]}
          images={previewImages}
          activeIndex={preview.activeIndex}
          onActiveIndexChange={(activeIndex) => setPreview({ ...preview, activeIndex })}
          onClose={handleClose}
        />
      ) : null}
    </div>
  );
}
