"use client";

import type { ApprovalPreviewV1 } from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "./review-workspace-view";
import { OriginalListingPanel } from "./original-listing-panel";
import { TargetListingPanel } from "./target-listing-panel";
import { FinalImageOrder } from "./final-image-order";
import { ApprovalActions, type ReviewActions } from "./approval-actions";

function displayCanvasStatus(workspace: ReviewWorkspaceView): string {
  if (workspace.reviewFacts.orderedFinalImages.length > 0) return "图片已生成";
  if (workspace.canvas?.state === "succeeded") return "待选最终图";
  if (workspace.canvas?.state === "running") return "生图中";
  return "待处理";
}

function displaySkuCount(count: number | null): string {
  return count === null ? "SKU 数量未知" : `SKU ${count} 个`;
}

function displayDimensions(dimensions: ReviewWorkspaceView["reviewFacts"]["dimensions"]): string {
  return dimensions
    ? `${dimensions.lengthCm} × ${dimensions.widthCm} × ${dimensions.heightCm} cm`
    : "尺寸未知";
}

function ReviewNextStepPanel({ workspace }: { workspace: ReviewWorkspaceView }) {
  const target = workspace.reviewFacts.canonicalMiaoshouTarget;
  return (
    <section aria-label="下一步写回" className="tk-panel tk-review__next-step">
      <div>
        <p>下一步</p>
        <h2>确认后写入妙手采集箱</h2>
        <span>只更新已采集商品的草稿资料，不发布到店铺。</span>
      </div>
      <dl>
        <div><dt>妙手目标</dt><dd>{target ? `妙手目标 ${target}` : "妙手目标未知"}</dd></div>
        <div><dt>当前版本</dt><dd>草稿 v{workspace.draftVersion}</dd></div>
        <div><dt>处理链路</dt><dd>采集 → 标题清洗 → Canvas 生图 → 人工确认 → 妙手待发布</dd></div>
      </dl>
    </section>
  );
}

function ReviewGeneratedInfoPanel({ workspace }: { workspace: ReviewWorkspaceView }) {
  return (
    <section aria-label="AI生成信息" className="tk-panel tk-review__generated">
      <header>
        <h2>AI生成信息</h2>
        <span>{workspace.target?.provider ?? "provider 待定"} · {workspace.target?.model ?? "model 待定"}</span>
      </header>
      <div className="tk-review__generated-grid">
        <section aria-label="中文原始 Listing" className="tk-review__info-card">
          <p>采集标题</p>
          <h3>{workspace.originalListing?.sourceTitle ?? "未采集到原始标题"}</h3>
          <span>{workspace.originalListing?.description ?? "未采集到原始描述"}</span>
        </section>
        <section aria-label={`${workspace.target?.locale ?? "未设置语言"} 目标 Listing`} className="tk-review__info-card is-primary">
          <p>目标标题</p>
          <h3>{workspace.target?.title ?? "等待生成目标标题"}</h3>
          <span>{workspace.target?.description ?? "等待生成目标描述"}</span>
        </section>
      </div>
      <dl className="tk-review__info-list">
        <div><dt>目标语言</dt><dd>{workspace.target?.locale ?? "未设置"}</dd></div>
        <div><dt>标题风格</dt><dd>{workspace.target?.style ?? "未设置"}</dd></div>
        <div><dt>Canvas模板</dt><dd>{workspace.template?.matchedReason ?? "TK工作流"}</dd></div>
        <div><dt>模板版本</dt><dd>{workspace.template ? `v${workspace.template.version}` : "未匹配"}</dd></div>
      </dl>
    </section>
  );
}

function ReviewSkuPanel({ workspace }: { workspace: ReviewWorkspaceView }) {
  return (
    <section aria-label="SKU确认" className="tk-panel tk-review__sku">
      <header><h2>SKU确认</h2><strong>{displaySkuCount(workspace.reviewFacts.skuCount)}</strong></header>
      <dl>
        <div><dt>库存</dt><dd>{workspace.reviewFacts.stock === null ? "库存未知" : `库存 ${workspace.reviewFacts.stock}`}</dd></div>
        <div><dt>重量</dt><dd>{workspace.reviewFacts.weightKg === null ? "重量未知" : `重量 ${workspace.reviewFacts.weightKg} kg`}</dd></div>
        <div><dt>尺寸</dt><dd>{displayDimensions(workspace.reviewFacts.dimensions)}</dd></div>
        <div><dt>源属性</dt><dd>{workspace.originalListing?.sourceAttributes.length ?? 0} 项</dd></div>
        <div><dt>销售属性</dt><dd>{workspace.originalListing?.saleAttributes.length ?? 0} 项</dd></div>
      </dl>
    </section>
  );
}

export function FinalReview({ workspace, approvalPreview, actions }: {
  workspace: ReviewWorkspaceView;
  approvalPreview?: ApprovalPreviewV1 | null;
  actions?: ReviewActions;
}) {
  const canvasOutputs = workspace.canvas?.outputs ?? [];
  return (
    <article aria-label={`最终审核 ${workspace.productId}`} className="tk-review">
      <header className="tk-page-heading tk-review__heading">
        <div>
          <p>商品详情 / 图片确认 · v{workspace.draftVersion}</p>
          <h1>{workspace.target?.title ?? workspace.originalListing?.sourceTitle ?? workspace.productId}</h1>
          <div className="tk-review__meta-row">
            <span>{workspace.originalListing?.sourceTitle ?? "原始标题待采集"}</span>
            <span>{workspace.revisionId}</span>
          </div>
        </div>
        <a className="tk-review__back-link" href="/products">返回商品处理台</a>
      </header>
      <div className="tk-review__workspace">
        <section aria-label="图片确认" className="tk-review__images">
          <header className="tk-review__image-header">
            <div>
              <p>图片确认</p>
              <h2>{displayCanvasStatus(workspace)}</h2>
            </div>
            <span>{workspace.reviewFacts.orderedFinalImages.length} / {canvasOutputs.length || "—"}</span>
          </header>
          <div className="tk-review__image-tabs" aria-label="图片来源统计">
            <span>AI图 {canvasOutputs.length}</span>
            <span>采集图 {workspace.reviewFacts.orderedFinalImages.length + (workspace.originalListing?.mainImages.length ?? 0) + (workspace.originalListing?.detailImages.length ?? 0)}</span>
            <span>最终图 {workspace.reviewFacts.orderedFinalImages.length}</span>
          </div>
          <FinalImageOrder orderedFinalImages={workspace.reviewFacts.orderedFinalImages} outputs={canvasOutputs} />
        </section>
        <section aria-label="商品内容" className="tk-review__content">
          <ReviewNextStepPanel workspace={workspace} />
          <ReviewGeneratedInfoPanel workspace={workspace} />
          <ReviewSkuPanel workspace={workspace} />
          <details className="tk-review__raw-details">
            <summary>查看采集原文和属性明细</summary>
            <div className="tk-review__raw-listings">
              <OriginalListingPanel listing={workspace.originalListing} skuCount={workspace.reviewFacts.skuCount} />
              <TargetListingPanel target={workspace.target} />
            </div>
          </details>
        </section>
        <aside aria-label="检查结果" className="tk-review__decision">
          <section aria-label="风险告警" className="tk-panel tk-review__check">
            <header>
              <div>
                <p>检查结果</p>
                <h2>{workspace.warningCodes.length > 0 ? "需要复核" : "检查通过"}</h2>
              </div>
              <span>{workspace.warningCodes.length} 项</span>
            </header>
            {workspace.warningCodes.length > 0
              ? <ul>{workspace.warningCodes.map((code) => <li key={code}>{code}</li>)}</ul>
              : <p>当前没有阻断告警</p>}
          </section>
          <ApprovalActions
            productId={String(workspace.productId)}
            revisionId={String(workspace.revisionId)}
            draftVersion={workspace.draftVersion}
            listingRunId={approvalPreview?.listingRunId ?? ""}
            templateVersion={approvalPreview?.templateVersion ?? workspace.template?.version ?? 1}
            orderedFinalAssetIds={(approvalPreview?.orderedFinalAssetIds ?? workspace.finalAssetOrder).map(String)}
            targetLocale={workspace.target?.locale ?? approvalPreview?.locale ?? "th-TH"}
            translationStyle={workspace.target?.style ?? "marketplace"}
            actions={actions}
          />
        </aside>
      </div>
    </article>
  );
}
