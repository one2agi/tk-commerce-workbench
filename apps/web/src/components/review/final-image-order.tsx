import type { ReviewWorkspaceView } from "./review-workspace-view";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canvasPreviewUrl(
  output: string,
  orderedFinalImages: ReviewWorkspaceView["reviewFacts"]["orderedFinalImages"]
): string | null {
  if (isHttpUrl(output) || output.startsWith("/api/")) return output;
  if (/^asset_[A-Za-z0-9_-]+$/.test(output)) {
    return `/api/v1/assets/${encodeURIComponent(output)}/content?variant=thumbnail`;
  }
  return orderedFinalImages.find((image) => image.assetId === output)?.thumbnailUrl ?? null;
}

export type FinalImageCandidate = Readonly<{
  assetId: string;
  previewUrl: string;
  thumbnailUrl?: string;
  kind: "processed" | "source";
}>;

/**
 * Builds the list of final image candidates for review.
 * Only accepted successful generated (processed) assets are included.
 * Source images from originalListing are NOT mixed in.
 */
export function buildFinalImageCandidates(
  workspace: Pick<ReviewWorkspaceView, "reviewFacts" | "originalListing">
): FinalImageCandidate[] {
  // Only accepted successful generated images enter the final order.
  // Source images from originalListing (mainImages, detailImages) are never mixed in.
  return workspace.reviewFacts.orderedFinalImages.map((image) => ({
    assetId: image.assetId,
    previewUrl: image.previewUrl,
    thumbnailUrl: image.thumbnailUrl,
    kind: "processed" as const
  }));
}

export function FinalImageOrder({ orderedFinalImages, outputs }: {
  orderedFinalImages: ReviewWorkspaceView["reviewFacts"]["orderedFinalImages"];
  outputs: string[];
}) {
  const selectedAssetIds = new Set(orderedFinalImages.map((image) => image.assetId));
  const selectedPreviewUrls = new Set(orderedFinalImages.flatMap((image) => [image.previewUrl, image.thumbnailUrl ?? image.previewUrl]));
  const pendingImages = outputs.flatMap((output, index) => {
    if (selectedAssetIds.has(output) || selectedPreviewUrls.has(output)) return [];
    const previewUrl = canvasPreviewUrl(output, orderedFinalImages);
    return previewUrl ? [{ key: `${output}:${index}`, previewUrl }] : [];
  });
  return (
    <section aria-label="最终图片顺序" className="tk-panel">
      <header><h2>最终图片</h2><span>{orderedFinalImages.length} 张已确认 · {pendingImages.length} 张待确认图片</span></header>
      <ol className="tk-review__asset-order">
        {orderedFinalImages.map((image, index) => <li key={image.assetId}>
          <span>最终图 {index + 1}</span>
          <img src={image.thumbnailUrl ?? image.previewUrl} alt={`最终图片 ${index + 1}`} width="160" height="160" loading="lazy" />
        </li>)}
      </ol>
      <div className="tk-review__canvas-grid">
        {pendingImages.map((image, index) => (
          <figure key={image.key}>
            <img src={image.previewUrl} alt={`待确认图片 ${index + 1}`} width="320" height="320" loading="lazy" />
            <figcaption>待确认成图 {index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
