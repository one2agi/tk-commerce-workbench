"use client";

import { Fragment, useState, type ChangeEvent, type ReactElement, type UIEvent } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import type { StageKey } from "./product-workbench.selectors";
import type { StartStatus } from "./product-workbench.state";
import { ProductImageGallery } from "./product-image-gallery";
import { buildProductRowView } from "./product-row-view";

type Props = Readonly<{
  items: ReadonlyArray<ProductPoolItemV1>;
  filtered: ReadonlyArray<ProductPoolItemV1>;
  selectedIds: ReadonlySet<string>;
  startStatusById: ReadonlyMap<string, StartStatus>;
  activeStage: StageKey;
  onToggleSelection: (productId: string) => void;
  onOpenDrawer: (productId: string) => void;
  onScroll: (scrollTop: number) => void;
  scrollTop: number;
  onStart: (productId: string) => void;
}>;

const STAGE_STATE_LABEL: Readonly<Record<StageKey, string>> = {
  all: "全部",
  pending: "待处理",
  processing: "自动处理中",
  review: "待确认",
  needs_attention: "需要人工处理",
  synced: "已完成"
};

function ProductThumbnail({ src }: { src: string | null }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="tk-product-table__thumb-empty">图</span>;
  return <img src={src} alt="商品缩略图" loading="lazy" onError={() => setFailed(true)} />;
}

function startBlockedReason(item: ProductPoolItemV1): string | null {
  if (
    item.miaoshouSource === "local_captured"
    && item.sourceCaptureQuality !== "detail_page_complete"
  ) {
    return "本地采集不完整，请重新采集";
  }
  if (item.sourceImageCount <= 0) return "1688 详情数据没有可用图片";
  if (!(
    item.miaoshouSource === "local_captured"
    || item.miaoshouSource === "success"
    || item.miaoshouSource === "skipped_duplicate"
  )) return "详情采集尚未成功";
  return null;
}

export function ProductTable({
  items,
  filtered,
  selectedIds,
  startStatusById,
  activeStage,
  onToggleSelection,
  onScroll,
  scrollTop,
  onStart
}: Props): ReactElement {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());

  const allCollapsed =
    filtered.length > 0 &&
    filtered.every((item) => collapsedIds.has(String(item.productId)));

  function toggleGallery(productId: string): void {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }

  function toggleAllGalleries(): void {
    if (allCollapsed) {
      setCollapsedIds(new Set());
    } else {
      setCollapsedIds(new Set(filtered.map((item) => String(item.productId))));
    }
  }

  function handleScroll(ev: UIEvent<HTMLDivElement>): void {
    onScroll(ev.currentTarget.scrollTop);
  }
  return (
    <div
      className="tk-product-table"
      role="region"
      aria-label={`${STAGE_STATE_LABEL[activeStage]}商品表（${filtered.length}/${items.length}）`}
    >
      <div
        className="tk-product-table__scroll"
        data-testid="product-table-scroll"
        onScroll={handleScroll}
        // scrollTop is restored by the parent after re-render.
        // We use a non-controlled style attribute so React doesn't fight us.
        style={{ overflowY: "auto", maxHeight: "60vh" }}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">选择</th>
              <th scope="col">标题</th>
              <th scope="col">来源</th>
              <th scope="col">来源价格</th>
              <th scope="col">采集时间</th>
              <th scope="col">业务状态</th>
              <th scope="col">图片进度</th>
              <th scope="col">问题提示</th>
              <th scope="col">下一步</th>
              <th scope="col">
                <div className="tk-product-table__header-cell">
                  <span>操作</span>
                  <button
                    type="button"
                    className="tk-product-table__toggle-all-gallery"
                    aria-expanded={!allCollapsed}
                    aria-label={allCollapsed ? "展开全部商品图片" : "折叠全部商品图片"}
                    onClick={toggleAllGalleries}
                    disabled={filtered.length === 0}
                  >
                    {allCollapsed ? "展开全部图片" : "折叠全部图片"}
                  </button>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const productId = String(item.productId);
              const checked = selectedIds.has(productId);
              const startStatus = startStatusById.get(productId) ?? "idle";
              const row = buildProductRowView(item, startStatus);
              const selectable = row.canBatchStart || row.canBatchConfirm || row.canBatchRetry;
              const blockedReason = row.nextAction.kind === "start" && !row.nextAction.enabled
                ? startBlockedReason(item)
                : null;
              const isCollapsed = collapsedIds.has(productId);
              return (
                <Fragment key={productId}>
                  <tr data-product-summary-for={productId} aria-selected={checked}>
                  <td>
                    <label className="tk-product-table__checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && !selectable}
                        aria-label={`选择商品 ${productId}`}
                        onChange={(_e: ChangeEvent<HTMLInputElement>) =>
                          onToggleSelection(productId)
                        }
                      />
                    </label>
                  </td>
                  <td>
                    <a
                      href={`/products/${encodeURIComponent(productId)}`}
                      aria-label={`查看商品图片 ${productId}`}
                      className="tk-product-table__product"
                    >
                      <ProductThumbnail src={row.thumbnailUrl} />
                      <span>{row.title}</span>
                    </a>
                  </td>
                  <td>
                    {row.sourceUrl ? (
                      <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.sourceLabel}</a>
                    ) : row.sourceLabel}
                  </td>
                  <td>{formatSourcePrice(item.sourcePriceWire)}</td>
                  <td>{row.collectedAtLabel}</td>
                  <td>{row.businessStatusLabel}</td>
                  <td>{row.imageProgressLabel}</td>
                  <td>{row.issueLabel ?? "—"}</td>
                  <td>
                    <div className="tk-product-table__actions">
                      {row.nextAction.kind === "start" ? (
                        <button
                          type="button"
                          aria-label={`${row.nextAction.label} ${productId}`}
                          disabled={!row.nextAction.enabled}
                          title={blockedReason ?? undefined}
                          onClick={() => onStart(productId)}
                        >
                          {row.nextAction.label}
                        </button>
                      ) : (
                        <a href={row.nextAction.href} aria-label={`${row.nextAction.label} ${productId}`}>
                          {row.nextAction.label}
                        </a>
                      )}
                      {blockedReason ? (
                        <span className="tk-start-status">{blockedReason}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="tk-product-table__row-actions">
                      <a href={`/products/${encodeURIComponent(productId)}`} aria-label={`查看详情 ${productId}`}>
                        查看
                      </a>
                      <button
                        type="button"
                        className="tk-product-table__toggle-gallery"
                        aria-expanded={!isCollapsed}
                        aria-label={`${isCollapsed ? "展开图片" : "折叠图片"} ${productId}`}
                        onClick={() => toggleGallery(productId)}
                      >
                        {isCollapsed ? "展开图片" : "折叠图片"}
                      </button>
                    </div>
                  </td>
                  </tr>
                  {!isCollapsed ? (
                    <tr className="tk-product-table__gallery-row" data-product-gallery-for={productId}>
                      <td colSpan={10}>
                        <div role="group" aria-label={`商品 ${productId} 图片`}>
                          <ProductImageGallery
                            productId={productId}
                            originalImageUrls={item.originalImageUrls}
                            processedImageUrls={item.processedImageUrls}
                          />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <span data-scroll-top-mirror={scrollTop} hidden />
      </div>
    </div>
  );
}

function formatSourcePrice(price: ProductPoolItemV1["sourcePriceWire"]): string {
  if (!price) return "—";
  const amount = BigInt(price.amountMinor);
  const decimal = `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
  return price.currency === "CNY" ? `¥${decimal}` : `${decimal} ${price.currency}`;
}
