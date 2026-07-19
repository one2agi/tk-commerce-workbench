import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

import { getServerServices } from "../../../server/composition";

type PageProps = { params: Promise<{ productId: string }> };
type ProductReader = { get(productId: string): Promise<ProductWorkspaceV1 | null> };

export async function renderProductPage(params: PageProps["params"], products: ProductReader) {
  const { productId } = await params;
  const workspace = await products.get(productId);
  if (!workspace) {
    return (
      <article aria-label={`未找到商品 ${productId}`}>
        <h1>未找到商品 {productId}</h1>
        <p>该商品不存在于当前工作区。</p>
      </article>
    );
  }
  return (
    <article aria-label={`商品详情 ${productId}`}>
      <h1>{workspace.originalListing?.sourceTitle ?? workspace.target?.title ?? productId}</h1>
      <p>当前详情页用于查看商品结果；如需启动标题清洗、定价和 Canvas 生图，请回到<a href="/">商品工作台</a>点击"开始处理"。</p>
      <dl>
        <dt>当前版本</dt>
        <dd>{String(workspace.revisionId)} / v{workspace.draftVersion}</dd>
        <dt>目标标题</dt>
        <dd>{workspace.target?.title ?? "尚未生成"}</dd>
        <dt>Canvas 状态</dt>
        <dd>{workspace.canvas?.state ?? "not_started"}</dd>
        <dt>成图数量</dt>
        <dd>{workspace.canvas?.outputs.length ?? 0}</dd>
        <dt>风险提示</dt>
        <dd>{workspace.warningCodes.length > 0 ? workspace.warningCodes.join("、") : "无"}</dd>
      </dl>
    </article>
  );
}

export default async function ProductPage({ params }: PageProps) {
  return renderProductPage(params, (await getServerServices()).products);
}
