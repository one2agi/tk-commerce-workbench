"use client";

import type { ApprovalPreviewV1 } from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "./review-workspace-view";
import { OriginalListingPanel } from "./original-listing-panel";
import { TargetListingPanel } from "./target-listing-panel";
import { PricingBreakdown } from "./pricing-breakdown";
import { FinalImageOrder } from "./final-image-order";
import { ApprovalActions, type ReviewActions } from "./approval-actions";

export function FinalReview({ workspace, approvalPreview, actions }: {
  workspace: ReviewWorkspaceView;
  approvalPreview?: ApprovalPreviewV1 | null;
  actions?: ReviewActions;
}) {
  return (
    <article aria-label={`最终审核 ${workspace.productId}`} className="tk-review">
      <header className="tk-page-heading">
        <div><p>最终审核 · v{workspace.draftVersion}</p><h1>{workspace.target?.title ?? workspace.originalListing?.sourceTitle ?? workspace.productId}</h1></div>
        <span>{workspace.revisionId}</span>
      </header>
      <div className="tk-review__listings">
        <OriginalListingPanel listing={workspace.originalListing} skuCount={workspace.reviewFacts.skuCount} />
        <TargetListingPanel target={workspace.target} />
      </div>
      <PricingBreakdown pricing={workspace.pricing} />
      <section aria-label="商品事实" className="tk-panel">
        <h2>商品事实</h2>
        <dl>
          <div><dt>库存</dt><dd>{workspace.reviewFacts.stock === null ? "库存未知" : `库存 ${workspace.reviewFacts.stock}`}</dd></div>
          <div><dt>重量</dt><dd>{workspace.reviewFacts.weightKg === null ? "重量未知" : `重量 ${workspace.reviewFacts.weightKg} kg`}</dd></div>
          <div><dt>尺寸</dt><dd>{workspace.reviewFacts.dimensions
            ? `${workspace.reviewFacts.dimensions.lengthCm} × ${workspace.reviewFacts.dimensions.widthCm} × ${workspace.reviewFacts.dimensions.heightCm} cm`
            : "尺寸未知"}</dd></div>
          <div><dt>妙手目标</dt><dd>{workspace.reviewFacts.canonicalMiaoshouTarget
            ? `妙手目标 ${workspace.reviewFacts.canonicalMiaoshouTarget}` : "妙手目标未知"}</dd></div>
        </dl>
      </section>
      <section aria-label="风险告警" className="tk-panel">
        <header><h2>风险告警</h2><span>{workspace.warningCodes.length} 项</span></header>
        {workspace.warningCodes.length > 0
          ? <ul>{workspace.warningCodes.map((code) => <li key={code}>{code}</li>)}</ul>
          : <p>当前没有阻断告警</p>}
      </section>
      <FinalImageOrder orderedFinalImages={workspace.reviewFacts.orderedFinalImages} outputs={workspace.canvas?.outputs ?? []} />
      <ApprovalActions
        productId={String(workspace.productId)}
        revisionId={String(workspace.revisionId)}
        draftVersion={workspace.draftVersion}
        listingRunId={approvalPreview?.listingRunId ?? ""}
        pricingRunId={approvalPreview?.pricingRunId ?? workspace.pricing?.pricingRunId ?? ""}
        templateVersion={approvalPreview?.templateVersion ?? workspace.template?.version ?? 1}
        orderedFinalAssetIds={(approvalPreview?.orderedFinalAssetIds ?? workspace.finalAssetOrder).map(String)}
        targetLocale={workspace.target?.locale ?? "th-TH"}
        translationStyle={workspace.target?.style ?? "marketplace"}
        actions={actions}
      />
    </article>
  );
}
