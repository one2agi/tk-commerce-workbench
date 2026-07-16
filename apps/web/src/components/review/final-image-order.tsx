import type { ReviewWorkspaceView } from "./review-workspace-view";

export function FinalImageOrder({ orderedFinalImages, outputs }: {
  orderedFinalImages: ReviewWorkspaceView["reviewFacts"]["orderedFinalImages"];
  outputs: string[];
}) {
  return (
    <section aria-label="最终图片顺序" className="tk-panel">
      <header><h2>最终图片</h2><span>{orderedFinalImages.length} 张已勾选 · {outputs.length} 张 Canvas 产出</span></header>
      <ol className="tk-review__asset-order">
        {orderedFinalImages.map((image, index) => <li key={image.assetId}>
          <span>{index + 1}</span>
          <img src={image.previewUrl} alt={`最终图片 ${index + 1}`} width="160" height="160" loading="lazy" />
          <code>{image.assetId}</code>
        </li>)}
      </ol>
      <div className="tk-review__canvas-grid">
        {outputs.map((url, index) => (
          <figure key={url}>
            <img src={url} alt={`Canvas 产出 ${index + 1}`} width="320" height="320" loading="lazy" />
            <figcaption>成图 {index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
