import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

export function FinalImageOrder({ finalAssetOrder, outputs }: {
  finalAssetOrder: ProductWorkspaceV1["finalAssetOrder"];
  outputs: string[];
}) {
  return (
    <section aria-label="最终图片顺序" className="tk-panel">
      <header><h2>最终图片</h2><span>{finalAssetOrder.length} 张已勾选 · {outputs.length} 张 Canvas 产出</span></header>
      <ol className="tk-review__asset-order">
        {finalAssetOrder.map((id, index) => <li key={String(id)}><span>{index + 1}</span>{String(id)}</li>)}
      </ol>
      <div className="tk-review__canvas-grid">
        {outputs.map((url, index) => (
          <figure key={url}>
            <img src={url} alt={`Canvas 产出 ${index + 1}`} />
            <figcaption>成图 {index + 1}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
