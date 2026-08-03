"use client";

import { useMemo, useState, type ReactElement } from "react";
import type { ReviewWorkspaceView } from "../review/review-workspace-view";
import { FinalImageOrder } from "../review/final-image-order";
import { ImageGenerationPanel } from "./image-generation-panel";
import { ProductImageGallery, type ProductGalleryImage } from "./product-image-gallery";

function legacyPreviewUrl(output: string): string | null {
  if (output.startsWith("/api/") || /^https?:\/\//.test(output)) return output;
  if (/^asset_[A-Za-z0-9_-]+$/.test(output)) {
    return `/api/v1/assets/${encodeURIComponent(output)}/content`;
  }
  return null;
}

export function buildCollectedImages(workspace: ReviewWorkspaceView): ProductGalleryImage[] {
  const sourceUrls = [
    ...(workspace.originalListing?.mainImages ?? []),
    ...(workspace.originalListing?.detailImages ?? [])
  ];
  const availableInputs = workspace.imageGeneration?.availableInputs ?? [];
  const localBySourceUrl = new Map(
    availableInputs.flatMap((input) => input.sourceUrl ? [[input.sourceUrl, input] as const] : [])
  );
  const usedAssetIds = new Set<string>();
  const collected = sourceUrls.map((url, index): ProductGalleryImage => {
    const local = localBySourceUrl.get(url);
    if (local) usedAssetIds.add(String(local.assetId));
    return local ? {
      key: `asset:${local.assetId}`,
      url: local.localUrl,
      assetId: String(local.assetId),
      selectable: true
    } : {
      key: `source:${index}:${url}`,
      url,
      assetId: null,
      selectable: false
    };
  });

  for (const input of availableInputs) {
    const id = String(input.assetId);
    if (usedAssetIds.has(id)) continue;
    collected.push({
      key: `asset:${id}`,
      url: input.localUrl,
      assetId: id,
      selectable: true
    });
  }

  const seen = new Set<string>();
  return collected.filter((image) => {
    const identity = image.assetId ? `asset:${image.assetId}` : `url:${image.url}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function buildProcessedImages(workspace: ReviewWorkspaceView): ProductGalleryImage[] {
  const images: ProductGalleryImage[] = [];
  for (const slot of workspace.imageGeneration?.slots ?? []) {
    if (slot.status !== "succeeded" || !slot.localUrl) continue;
    images.push({
      key: `slot:${slot.slotId}`,
      url: slot.localUrl,
      assetId: null,
      selectable: false
    });
  }
  for (const [index, output] of (workspace.canvas?.outputs ?? []).entries()) {
    const url = legacyPreviewUrl(output);
    if (!url) continue;
    images.push({
      key: `legacy:${index}:${output}`,
      url,
      assetId: null,
      selectable: false
    });
  }
  const seenUrls = new Set<string>();
  return images.filter((image) => {
    if (seenUrls.has(image.url)) return false;
    seenUrls.add(image.url);
    return true;
  });
}

export function ProductImageWorkbench({ workspace }: { workspace: ReviewWorkspaceView }): ReactElement {
  const initiallySelected = workspace.imageGeneration?.selectedInputs.map((input) => String(input.assetId)) ?? [];
  const [selectedAssetIds, setSelectedAssetIds] = useState<ReadonlySet<string>>(() => new Set(initiallySelected));
  const originalImages = useMemo(() => buildCollectedImages(workspace), [workspace]);
  const processedImages = useMemo(() => buildProcessedImages(workspace), [workspace]);
  const canvasOutputs = workspace.canvas?.outputs ?? [];

  function toggleOriginal(assetId: string): void {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else if (next.size < 6) next.add(assetId);
      return next;
    });
  }

  return (
    <section aria-label="图片工作台" className="tk-review__image-workbench">
      <header className="tk-review__image-header">
        <div>
          <p>图片工作台</p>
          <h2>选择原图、洗图并确认最终图片</h2>
        </div>
        <span>已选原图 {selectedAssetIds.size}/6</span>
      </header>
      <ProductImageGallery
        productId={String(workspace.productId)}
        originalImages={originalImages}
        processedImages={processedImages}
        selectedOriginalAssetIds={selectedAssetIds}
        onToggleOriginal={toggleOriginal}
      />
      <ImageGenerationPanel
        productId={String(workspace.productId)}
        revisionId={String(workspace.revisionId)}
        imageGeneration={workspace.imageGeneration}
        selectedAssetIds={selectedAssetIds}
        onSelectedAssetIdsChange={setSelectedAssetIds}
        showInputGallery={false}
      />
      <FinalImageOrder
        orderedFinalImages={workspace.reviewFacts.orderedFinalImages}
        outputs={canvasOutputs}
      />
    </section>
  );
}
