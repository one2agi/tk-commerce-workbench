"use client";

import type { ApprovalPreviewV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";
import { OriginalListingPanel } from "./original-listing-panel";
import { TargetListingPanel } from "./target-listing-panel";
import { PricingBreakdown } from "./pricing-breakdown";
import { FinalImageOrder } from "./final-image-order";
import { ApprovalActions, type ReviewActions } from "./approval-actions";

export function FinalReview({ workspace, approvalPreview, actions }: {
  workspace: ProductWorkspaceV1;
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
        <OriginalListingPanel listing={workspace.originalListing} />
        <TargetListingPanel target={workspace.target} />
      </div>
      <PricingBreakdown pricing={workspace.pricing} />
      <section aria-label="风险告警" className="tk-panel">
        <header><h2>风险告警</h2><span>{workspace.warningCodes.length} 项</span></header>
        {workspace.warningCodes.length > 0
          ? <ul>{workspace.warningCodes.map((code) => <li key={code}>{code}</li>)}</ul>
          : <p>当前没有阻断告警</p>}
      </section>
      <FinalImageOrder finalAssetOrder={workspace.finalAssetOrder} outputs={workspace.canvas?.outputs ?? []} />
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
