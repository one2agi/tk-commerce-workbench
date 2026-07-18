import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

function formatPrice(item: ProductPoolItemV1): string {
  if (!item.priceWire) return "—";
  const minor = Number(item.priceWire.amountMinor);
  if (!Number.isFinite(minor)) return "—";
  return `${(minor / 100).toFixed(2)} ${item.priceWire.currency}`;
}

export function renderProductsPage(data: { items: ProductPoolItemV1[] }) {
  const { items } = data;
  return <section aria-label="商品列表">
    <header className="tk-page-heading">
      <div><p>Catalog</p><h1>商品列表</h1></div>
      <span>{items.length} 个商品</span>
    </header>
    <p>浏览当前工作区已收录的全部商品；点击商品行进入单商品工作区进行素材归档、Listing、定价、Canvas 与妙手同步。需要批量操作请使用商品工作台。</p>
    <div className="tk-product-table tk-product-list-table">
      <table>
        <thead><tr>
          <th scope="col">商品</th>
          <th scope="col">源标题</th>
          <th scope="col">目标标题</th>
          <th scope="col">价格</th>
          <th scope="col">状态</th>
          <th scope="col">风险提示</th>
          <th scope="col">详情</th>
        </tr></thead>
        <tbody>
          {items.length === 0
            ? <tr className="tk-product-list-table__empty-row">
                <td colSpan={7} className="tk-product-list-table__empty">
                  <span className="tk-product-list-table__empty-title">暂无商品</span>
                  <span className="tk-product-list-table__empty-hint">到<a href="/">商品工作台</a>同步第一条商品</span>
                </td>
              </tr>
            : items.map((item) => <tr key={String(item.productId)}>
                <td><strong>{String(item.productId)}</strong></td>
                <td>{item.canonicalSourceTitle ?? "—"}</td>
                <td>{item.targetTitle ?? "—"}</td>
                <td>{formatPrice(item)}</td>
                <td>{item.approval}</td>
                <td>{item.warningCodes.length > 0 ? item.warningCodes.join("、") : "—"}</td>
                <td><a href={`/products/${String(item.productId)}`} aria-label={`进入 ${String(item.productId)} 详情`}>查看 →</a></td>
              </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

export default async function ProductsPage() {
  return renderProductsPage(await (await getServerServices()).products.list());
}
