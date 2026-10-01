"use client";

import { useMemo, useState, type ReactElement } from "react";
import type { ReviewWorkspaceView } from "../review/review-workspace-view";
import { FinalImageOrder } from "../review/final-image-order";
import { ImageGenerationPanel } from "./image-generation-panel";
import { ProductImageGallery, type ProductGalleryImage } from "./product-image-gallery";
import { IconChevronDown, IconSparkles } from "../review/review-icons";

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

  // 是否处于可用就绪状态：只要已有成功生图且当前没有正在生成的卡片，即视为已就绪展示
  const inFlightCount = workspace.imageGeneration?.slots.filter((s) =>
    ["waiting_for_plan", "queued", "running"].includes(s.status)
  ).length ?? 0;
  const successfulCount = workspace.imageGeneration?.slots.filter((s) => s.status === "succeeded").length ?? 0;
  const isImageGenReady = successfulCount > 0 && inFlightCount === 0;

  return (
    <section aria-label="图片工作台" className="tk-review__image-workbench">
      <ProductImageGallery
        productId={String(workspace.productId)}
        originalImages={originalImages}
        processedImages={processedImages}
        selectedOriginalAssetIds={selectedAssetIds}
        onToggleOriginal={toggleOriginal}
      />
      {workspace.imageGeneration ? (
        <details className="tk-image-tuning-drawer" open={!isImageGenReady}>
          <summary className="tk-image-tuning-drawer__summary">
            <div className="tk-image-tuning-drawer__summary-left">
              <IconSparkles />
              <span>生图参数与顺序微调</span>
              {isImageGenReady ? (
                <span className="tk-badge-ready-pill">{successfulCount} 张已就绪</span>
              ) : inFlightCount > 0 ? (
                <span className="tk-badge-warn-pill">正在生成中</span>
              ) : (
                <span className="tk-badge-warn-pill">需配置洗图</span>
              )}
            </div>
            <div className="tk-image-tuning-drawer__summary-right">
              <span>{isImageGenReady ? "微调顺序或单张重试" : "收起控制台"}</span>
              <IconChevronDown />
            </div>
          </summary>
          <div className="tk-image-tuning-drawer__content">
            <ImageGenerationPanel
              productId={String(workspace.productId)}
              revisionId={String(workspace.revisionId)}
              imageGeneration={workspace.imageGeneration}
              selectedAssetIds={selectedAssetIds}
              onSelectedAssetIdsChange={setSelectedAssetIds}
              showInputGallery={false}
            />
          </div>
        </details>
      ) : (
        <details className="tk-image-tuning-drawer" open={workspace.reviewFacts.orderedFinalImages.length === 0}>
          <summary className="tk-image-tuning-drawer__summary">
            <div className="tk-image-tuning-drawer__summary-left">
              <IconSparkles />
              <span>刊登图片排布明细</span>
            </div>
            <div className="tk-image-tuning-drawer__summary-right">
              <IconChevronDown />
            </div>
          </summary>
          <div className="tk-image-tuning-drawer__content">
            <FinalImageOrder
              orderedFinalImages={workspace.reviewFacts.orderedFinalImages}
              outputs={canvasOutputs}
            />
          </div>
        </details>
      )}
    </section>
  );
}
