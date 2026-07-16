import type { ApprovalPreviewV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "../../../../components/review/review-workspace-view";
import { FinalReview } from "../../../../components/review/final-review";
import { getServerServices } from "../../../../server/composition";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ productId: string }> };
type ReviewReader = {
  get(productId: string): Promise<ProductWorkspaceV1 | null>;
  preview?(productId: string): Promise<ApprovalPreviewV1 | null>;
  facts(productId: string): Promise<ReviewWorkspaceView["reviewFacts"]>;
};

export async function renderReviewPage(params: PageProps["params"], reader: ReviewReader) {
  const { productId } = await params;
  const [workspace, approvalPreview, reviewFacts] = await Promise.all([
    reader.get(productId),
    reader.preview?.(productId) ?? Promise.resolve(null),
    reader.facts(productId)
  ]);
  if (!workspace) return <article><h1>未找到商品 {productId}</h1></article>;
  return <FinalReview workspace={{ ...workspace, reviewFacts }} approvalPreview={approvalPreview} />;
}

export default async function ReviewPage({ params }: PageProps) {
  return renderReviewPage(params, (await getServerServices()).products);
}
