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
  return orderedFinalImages.find((image) => image.assetId === output)?.previewUrl ?? null;
}

export function FinalImageOrder({ orderedFinalImages, outputs }: {
  orderedFinalImages: ReviewWorkspaceView["reviewFacts"]["orderedFinalImages"];
  outputs: string[];
}) {
  const canvasImages = outputs.flatMap((output, index) => {
    const previewUrl = canvasPreviewUrl(output, orderedFinalImages);
    return previewUrl ? [{ key: `${output}:${index}`, previewUrl }] : [];
  });
  return (
    <section aria-label="最终图片顺序" className="tk-panel">
      <header><h2>最终图片</h2><span>{orderedFinalImages.length} 张已勾选 · {outputs.length} 张 Canvas 产出</span></header>
      <ol className="tk-review__asset-order">
        {orderedFinalImages.map((image, index) => <li key={image.assetId}>
          <span>最终图 {index + 1}</span>
          <img src={image.previewUrl} alt={`最终图片 ${index + 1}`} width="160" height="160" loading="lazy" />
        </li>)}
      </ol>
      <div className="tk-review__canvas-grid">
        {canvasImages.map((image, index) => (
          <figure key={image.key}>
            <img src={image.previewUrl} alt={`Canvas 产出 ${index + 1}`} width="320" height="320" loading="lazy" />
            <figcaption>成图 {index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
