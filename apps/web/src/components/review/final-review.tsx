"use client";

import type { ApprovalPreviewV1 } from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "./review-workspace-view";
import { ProductImageWorkbench } from "../products/product-image-workbench";
import { OriginalListingPanel } from "./original-listing-panel";
import { TargetListingPanel } from "./target-listing-panel";
import { ApprovalActions, type ReviewActions } from "./approval-actions";
import { IconArrowLeft, IconCheckCircle, IconSparkles } from "./review-icons";

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
        <p>下一步（写回目标）</p>
        <h2>确认后写入妙手采集箱</h2>
        <span>只更新已采集商品的草稿资料，不发布到店铺。</span>
      </div>
      <dl>
        <div><dt>妙手目标</dt><dd>{target ? `妙手目标 ${target}` : "妙手目标未知"}</dd></div>
        <div><dt>流转状态</dt><dd>已就绪，待人工核验</dd></div>
      </dl>
    </section>
  );
}

function ReviewGeneratedInfoPanel({ workspace }: { workspace: ReviewWorkspaceView }) {
  return (
    <section aria-label="AI生成信息" className="tk-panel tk-review__generated">
      <header className="tk-review__panel-header">
        <div className="tk-review__panel-title-group">
          <IconSparkles />
          <h2>AI生成信息</h2>
        </div>
        <span className="tk-review__tech-subtext">AI 电商多语言与属性提炼</span>
      </header>
      <div className="tk-review__generated-grid">
        <section aria-label={`${workspace.target?.locale ?? "未设置语言"} 目标 Listing`} className="tk-review__info-card is-primary">
          <div className="tk-review__card-header">
            <span className="tk-badge-pill is-active">{workspace.target?.locale ?? "th-TH"} 目标译本</span>
            <p>目标标题</p>
          </div>
          <h3>{workspace.target?.title ?? "等待生成目标标题"}</h3>
          <span className="tk-review__desc-text">{workspace.target?.description ?? "等待生成目标描述"}</span>
        </section>
        <section aria-label="中文原始 Listing" className="tk-review__info-card is-source">
          <div className="tk-review__card-header">
            <span className="tk-badge-pill">1688 原文</span>
            <p>采集标题</p>
          </div>
          <h3>{workspace.originalListing?.sourceTitle ?? "未采集到原始标题"}</h3>
          <span className="tk-review__desc-text">{workspace.originalListing?.description ?? "未采集到原始描述"}</span>
        </section>
      </div>
      <dl className="tk-review__info-list">
        <div><dt>目标语言</dt><dd>{workspace.target?.locale ?? "未设置"}</dd></div>
        <div><dt>标题风格</dt><dd>{workspace.target?.style === "marketplace" ? "电商转化型" : (workspace.target?.style ?? "未设置")}</dd></div>
        <div><dt>品类模板</dt><dd>{workspace.template?.matchedReason ?? "通用电商"}</dd></div>
      </dl>
    </section>
  );
}

function ReviewSkuPanel({ workspace }: { workspace: ReviewWorkspaceView }) {
  const isWeightClamped = workspace.reviewFacts.weightKg === "0.001";
  return (
    <section aria-label="SKU确认" className="tk-panel tk-review__sku">
      <header className="tk-review__panel-header">
        <h2>SKU确认</h2>
        <strong>{displaySkuCount(workspace.reviewFacts.skuCount)}</strong>
      </header>
      <dl className="tk-review__sku-metrics">
        <div className="tk-sku-pill">
          <dt>库存</dt>
          <dd>{workspace.reviewFacts.stock === null ? "库存未知" : `库存 ${workspace.reviewFacts.stock}`}</dd>
        </div>
        <div className="tk-sku-pill">
          <dt>重量</dt>
          <dd>
            {workspace.reviewFacts.weightKg === null ? "重量未知" : `重量 ${workspace.reviewFacts.weightKg} kg`}
            {isWeightClamped ? <span className="tk-sku-note">（写入妙手保底 0.01kg）</span> : null}
          </dd>
        </div>
        <div className="tk-sku-pill">
          <dt>尺寸</dt>
          <dd>{displayDimensions(workspace.reviewFacts.dimensions)}</dd>
        </div>
        <div className="tk-sku-pill">
          <dt>源属性</dt>
          <dd>{workspace.originalListing?.sourceAttributes.length ?? 0} 项</dd>
        </div>
        <div className="tk-sku-pill">
          <dt>销售属性</dt>
          <dd>{workspace.originalListing?.saleAttributes.length ?? 0} 项</dd>
        </div>
      </dl>
    </section>
  );
}

export function FinalReview({ workspace, approvalPreview, actions }: {
  workspace: ReviewWorkspaceView;
  approvalPreview?: ApprovalPreviewV1 | null;
  actions?: ReviewActions;
}) {
  return (
    <article aria-label={`最终审核 ${workspace.productId}`} className="tk-review">
      <div className="tk-review__container">
        {/* 顶部居中呼吸感 Header */}
        <header className="tk-page-heading tk-review__heading">
          <div className="tk-review__heading-main">
            <div className="tk-review__heading-nav">
              <a className="tk-review__back-link" href="/products">
                <IconArrowLeft />
                <span>返回商品处理台</span>
              </a>
              <span className="tk-eyebrow-pill">商品详情 / 图片确认</span>
            </div>
            <h1>{workspace.target?.title ?? workspace.originalListing?.sourceTitle ?? workspace.productId}</h1>
            <div className="tk-review__meta-row">
              <span className="tk-review__source-title">{workspace.originalListing?.sourceTitle ?? "原始标题待采集"}</span>
              <span className="tk-badge-locale">{workspace.target?.locale ? `${workspace.target.locale} 译本` : "待本地化"}</span>
              <span className="tk-badge-platform">1688 · {workspace.productId}</span>
            </div>
          </div>
        </header>

        {/* 核心视觉展台：大图预览 + 5张缩略胶囊 + 折叠式原图抽屉 */}
        <ProductImageWorkbench workspace={workspace} />

        {/* 下半部：文本质检、规格核验与放行审批 */}
        <div className="tk-review__lower">
          <section aria-label="商品内容" className="tk-review__content">
            <ReviewGeneratedInfoPanel workspace={workspace} />
            <ReviewSkuPanel workspace={workspace} />
            <ReviewNextStepPanel workspace={workspace} />

            {/* 采集原文和属性明细（默认折叠，不打扰主视觉） */}
            <details className="tk-review__raw-details">
              <summary>查看采集原文和属性明细</summary>
              <div className="tk-review__raw-listings">
                <OriginalListingPanel listing={workspace.originalListing} skuCount={workspace.reviewFacts.skuCount} />
                <TargetListingPanel target={workspace.target} />
              </div>
            </details>

            {/* 系统技术与链路参数（默认折叠排障抽屉） */}
            <details className="tk-review__tech-details">
              <summary>系统技术与链路参数（排障调试）</summary>
              <div className="tk-review__tech-grid">
                <div><span>内部版本ID</span><code>{workspace.revisionId}</code></div>
                <div><span>草稿版本</span><code>v{workspace.draftVersion}</code></div>
                <div><span>生成模型</span><code>{workspace.target?.provider ?? "—"} · {workspace.target?.model ?? "—"}</code></div>
                <div><span>洗图模板版本</span><code>{workspace.template ? `v${workspace.template.version}` : "未匹配"}</code></div>
                <div><span>底层处理链路</span><code>采集 → 文案处理 → 洗图 → 人工确认 → 妙手待发布</code></div>
              </div>
            </details>
          </section>

          <aside aria-label="检查结果" className="tk-review__decision">
            <section aria-label="风险告警" className="tk-panel tk-review__check">
              <header>
                <div className="tk-review__check-title">
                  <IconCheckCircle />
                  <div>
                    <p>检查结果</p>
                    <h2>{workspace.warningCodes.length > 0 ? "需要复核" : "检查通过"}</h2>
                  </div>
                </div>
                <span>{workspace.warningCodes.length} 项</span>
              </header>
              {workspace.warningCodes.length > 0
                ? <ul>{workspace.warningCodes.map((code) => <li key={code}>{code}</li>)}</ul>
                : <p className="tk-check-pass-text">当前没有阻断告警，规格与营销图已满足刊登要求</p>}
            </section>

            <ApprovalActions
              productId={String(workspace.productId)}
              revisionId={String(workspace.revisionId)}
              draftVersion={workspace.draftVersion}
              listingRunId={approvalPreview?.listingRunId ?? ""}
              templateVersion={approvalPreview?.templateVersion ?? workspace.template?.version ?? 1}
              orderedFinalAssetIds={(approvalPreview?.orderedFinalAssetIds ?? workspace.finalAssetOrder).map(String)}
              canonicalMiaoshouTarget={workspace.reviewFacts.canonicalMiaoshouTarget}
              firstFinalImageUrl={workspace.reviewFacts.orderedFinalImages[0]?.thumbnailUrl ?? workspace.reviewFacts.orderedFinalImages[0]?.previewUrl ?? null}
              targetLocale={workspace.target?.locale ?? approvalPreview?.locale ?? "th-TH"}
              translationStyle={workspace.target?.style ?? "marketplace"}
              miaoshouWriteback={approvalPreview?.miaoshouWriteback}
              actions={actions}
            />
          </aside>
        </div>
      </div>
    </article>
  );
}
