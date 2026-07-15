import { fixtures } from "../../../lib/fixtures";

type PageProps = { params: Promise<{ productId: string }> };

export default async function ProductPage({ params }: PageProps) {
  const { productId } = await params;
  const item = fixtures.productPool.find(
    (i) => String(i.productId) === productId
  );
  if (!item) {
    return (
      <article aria-label={`未找到商品 ${productId}`}>
        <h1>未找到商品 {productId}</h1>
        <p>该商品不存在于当前工作区。</p>
      </article>
    );
  }
  return (
    <article aria-label={`商品详情 ${productId}`}>
      <h1>{item.canonicalSourceTitle ?? productId}</h1>
      <dl>
        <dt>源商品 ID</dt>
        <dd>{String(item.productId)}</dd>
        <dt>采集状态</dt>
        <dd>{item.miaoshouSource}</dd>
        <dt>listing 状态</dt>
        <dd>{item.listing}</dd>
        <dt>妙手编辑状态</dt>
        <dd>{item.miaoshouEdit}</dd>
      </dl>
    </article>
  );
}
