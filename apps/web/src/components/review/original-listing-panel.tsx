import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

export function OriginalListingPanel({ listing, skuCount }: {
  listing: ProductWorkspaceV1["originalListing"];
  skuCount: number | null;
}) {
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
        <p className="tk-metric">{skuCount === null ? "SKU 数量未知" : `SKU ${skuCount} 个`}</p>
        {(listing.mainImages.length > 0 || listing.detailImages.length > 0) && <div aria-label="1688 原图证据">
          {[...listing.mainImages, ...listing.detailImages].map((url, index) =>
            <img key={`${url}:${index}`} src={url} alt={`1688 原图 ${index + 1}`} width="160" height="160" loading="lazy" />)}
        </div>}
      </> : <p>原始 Listing 尚未采集完成</p>}
    </section>
  );
}
