import type { ApprovalPreviewV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";

import { FinalReview } from "../../../components/review/final-review";
import type { ReviewWorkspaceView } from "../../../components/review/review-workspace-view";
import { getServerServices } from "../../../server/composition";

type PageProps = { params: Promise<{ productId: string }> };
type ProductReader = {
  get(productId: string): Promise<ProductWorkspaceV1 | null>;
  preview?(productId: string): Promise<ApprovalPreviewV1 | null>;
  facts(productId: string): Promise<ReviewWorkspaceView["reviewFacts"]>;
};

export async function renderProductPage(params: PageProps["params"], products: ProductReader) {
  const { productId } = await params;
  const [workspace, approvalPreview, reviewFacts] = await Promise.all([
    products.get(productId),
    products.preview?.(productId) ?? Promise.resolve(null),
    products.facts(productId)
  ]);
  if (!workspace) {
    return (
      <article aria-label={`未找到商品 ${productId}`}>
        <h1>未找到商品 {productId}</h1>
        <p>该商品不存在于当前工作区。</p>
      </article>
    );
  }
  return <FinalReview workspace={{ ...workspace, reviewFacts }} approvalPreview={approvalPreview} />;
}

export default async function ProductPage({ params }: PageProps) {
  return renderProductPage(params, (await getServerServices()).products);
}
