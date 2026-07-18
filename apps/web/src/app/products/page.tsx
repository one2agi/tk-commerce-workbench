import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

function formatPrice(item: ProductPoolItemV1): string {
  if (!item.priceWire) return "—";
  const minor = Number(item.priceWire.amountMinor);
  if (!Number.isFinite(minor)) return "—";
  return `${(minor / 100).toFixed(2)} ${item.priceWire.currency}`;
}

function statusLabel(approval: ProductPoolItemV1["approval"]): string {
  // Project only the workbench-relevant approval state to keep the row scannable.
  // Other pipeline states are surfaced on the detail page.
  return approval;
}

export function renderProductsPage(data: { items: ProductPoolItemV1[] }) {
  const { items } = data;
  return <section aria-label="商品列表">
    <header className="tk-page-heading">
      <div><p>Catalog</p><h1>商品列表</h1></div>
      <span>{items.length} 个商品</span>
    </header>
    <p>浏览当前工作区已收录的全部商品；点击商品行进入单商品工作区进行素材归档、Listing、定价、Canvas 与妙手同步。需要批量操作请使用商品工作台。</p>
    {items.length === 0
      ? <div className="tk-table-wrap tk-products-empty">还没有商品。先去商品工作台同步一条商品试试。</div>
      : <div className="tk-table-wrap"><table className="tk-product-list-table">
          <thead><tr>
            <th scope="col">商品</th>
            <th scope="col">源标题</th>
            <th scope="col">目标标题</th>
            <th scope="col">价格</th>
            <th scope="col">状态</th>
            <th scope="col">风险提示</th>
            <th scope="col">详情</th>
          </tr></thead>
          <tbody>{items.map((item) => <tr key={String(item.productId)}>
            <td><strong>{String(item.productId)}</strong></td>
            <td>{item.canonicalSourceTitle ?? "—"}</td>
            <td>{item.targetTitle ?? "—"}</td>
            <td>{formatPrice(item)}</td>
            <td>{statusLabel(item.approval)}</td>
            <td>{item.warningCodes.length > 0 ? item.warningCodes.join("、") : "—"}</td>
            <td><a href={`/products/${String(item.productId)}`} aria-label={`进入 ${String(item.productId)} 详情`}>查看 →</a></td>
          </tr>)}</tbody>
        </table></div>}
  </section>;
}

export default async function ProductsPage() {
  return renderProductsPage(await (await getServerServices()).products.list());
}
