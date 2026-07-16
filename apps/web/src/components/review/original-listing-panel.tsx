import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

export function OriginalListingPanel({ listing }: { listing: ProductWorkspaceV1["originalListing"] }) {
  return (
    <section aria-label="中文原始 Listing" className="tk-panel tk-review__source">
      <header><span>1688 原文</span><strong>中文</strong></header>
      {listing ? <>
        <h2>{listing.sourceTitle}</h2>
        <p>{listing.description || "暂无原始描述"}</p>
        <dl>
          {listing.sourceAttributes.map((attribute) => <div key={`${attribute.name}:${attribute.value}`}>
            <dt>{attribute.name}</dt><dd>{attribute.value}</dd>
          </div>)}
        </dl>
        <p className="tk-metric">SKU {listing.saleAttributes.length} 个</p>
      </> : <p>原始 Listing 尚未采集完成</p>}
    </section>
  );
}
