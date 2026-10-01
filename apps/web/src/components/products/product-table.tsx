"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ReactElement, type UIEvent } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import type { StageKey } from "./product-workbench.selectors";
import type { StartStatus } from "./product-workbench.state";
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
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) {
      setFailed(true);
    }
  }, [src]);

  if (!src || failed) {
    return (
      <span className="tk-product-table__thumb-fallback" role="img" aria-label="暂无图片">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </span>
    );
  }
  return (
    <img
      ref={imgRef}
      src={src}
      alt="商品缩略图"
      onLoad={(e) => {
        if (e.currentTarget.naturalWidth === 0) setFailed(true);
      }}
      onError={() => setFailed(true)}
    />
  );
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
  function handleScroll(ev: UIEvent<HTMLDivElement>): void {
    onScroll(ev.currentTarget.scrollTop);
  }
  return (
    <div
      className="tk-product-table tk-product-table--compact"
      role="region"
      aria-label={`${STAGE_STATE_LABEL[activeStage]}商品表（${filtered.length}/${items.length}）`}
    >
      <div
        className="tk-product-table__scroll"
        data-testid="product-table-scroll"
        onScroll={handleScroll}
        style={{ overflowY: "auto", maxHeight: "65vh" }}
      >
        <table>
          <thead>
            <tr>
              <th scope="col" className="tk-th-product">商品</th>
              <th scope="col" className="tk-th-images">图片</th>
              <th scope="col" className="tk-th-status">处理状态</th>
              <th scope="col" className="tk-th-time">更新时间</th>
              <th scope="col" className="tk-th-actions">操作</th>
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
              const usableCount = Math.min(item.usableCanvasOutputCount, 5);
              const isRunning = item.canvas === "running" || item.canvas === "queued" || startStatus === "pending";

              return (
                <tr key={productId} data-product-summary-for={productId} aria-selected={checked}>
                  {/* 1. 商品列: 勾选框 + 缩略图 + 标题 + 1688来源标签 + 采集时间 */}
                  <td className="tk-cell-product">
                    <div className="tk-product-meta-cell">
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
                      <a
                        href={`/products/${encodeURIComponent(productId)}`}
                        aria-label={`查看商品图片 ${productId}`}
                        className="tk-product-table__thumb-link"
                      >
                        <ProductThumbnail src={row.thumbnailUrl} />
                      </a>
                      <div className="tk-product-info-col">
                        <a
                          href={`/products/${encodeURIComponent(productId)}`}
                          className="tk-product-title"
                          title={row.title}
                        >
                          {row.title}
                        </a>
                        <div className="tk-product-tags-row">
                          <span className="tk-badge-platform">{row.sourceLabel}</span>
                          {item.sourcePriceWire ? (
                            <span className="tk-badge-price">{formatSourcePrice(item.sourcePriceWire)}</span>
                          ) : null}
                          <span className="tk-text-collected" suppressHydrationWarning>采集 {formatShortTime(item.collectedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* 2. 图片列: 主图 X/5 + 可视化进度条 + 说明 */}
                  <td className="tk-cell-images">
                    <div className="tk-image-progress-group">
                      <div className="tk-image-progress-header">
                        <span className="tk-image-progress-label">主图</span>
                        <span className="tk-image-progress-count">{usableCount}/5</span>
                      </div>
                      <div className="tk-progress-track">
                        <div
                          className={`tk-progress-bar ${
                            usableCount >= 5
                              ? "is-complete"
                              : isRunning
                                ? "is-running"
                                : ""
                          }`}
                          style={{ width: `${Math.min(100, (usableCount / 5) * 100)}%` }}
                        />
                      </div>
                      <span className="tk-sku-subtext">
                        {isRunning ? "AI生图中..." : item.canvas === "failed" ? "Canvas 失败" : "SKU 未生成"}
                      </span>
                    </div>
                  </td>

                  {/* 3. 处理状态列: 彩色状态药丸 */}
                  <td className="tk-cell-status">
                    <div className="tk-status-group">
                      <span className={`tk-status-pill is-${row.businessStage}`}>
                        {row.businessStage === "review"
                          ? "等写入"
                          : row.businessStage === "processing"
                            ? "AI图片生成中"
                            : row.businessStage === "synced"
                              ? "已完成"
                              : row.businessStage === "needs_attention"
                                ? "处理失败"
                                : "待处理"}
                      </span>
                      {row.issueLabel ? (
                        <span className="tk-status-issue" title={row.issueLabel}>{row.issueLabel}</span>
                      ) : null}
                    </div>
                  </td>

                  {/* 4. 更新时间列 */}
                  <td className="tk-cell-time">
                    <span className="tk-time-label" suppressHydrationWarning>{formatShortTime(item.updatedAt ?? item.collectedAt)}</span>
                  </td>

                  {/* 5. 操作列: 主行动点 + 详情链接 */}
                  <td className="tk-cell-actions">
                    <div className="tk-product-table__primary-action-cell">
                      {row.nextAction.kind === "start" ? (
                        <button
                          type="button"
                          className="tk-btn-action-start"
                          aria-label={`${row.nextAction.label} ${productId}`}
                          disabled={!row.nextAction.enabled}
                          title={blockedReason ?? undefined}
                          onClick={() => onStart(productId)}
                        >
                          {row.nextAction.label}
                        </button>
                      ) : row.nextAction.kind === "review" ? (
                        <a
                          href={row.nextAction.href}
                          className="tk-btn-action-review tk-btn-action-green"
                          aria-label={`${row.nextAction.label} ${productId}`}
                        >
                          写入妙手
                        </a>
                      ) : (
                        <a
                          href={row.nextAction.href}
                          className="tk-btn-action-link"
                          aria-label={`${row.nextAction.label} ${productId}`}
                        >
                          {row.nextAction.label}
                        </a>
                      )}
                      <a
                        href={`/products/${encodeURIComponent(productId)}`}
                        className="tk-product-table__sub-link"
                        aria-label={`查看详情 ${productId}`}
                      >
                        详情
                      </a>
                      {blockedReason ? (
                        <span className="tk-start-status">{blockedReason}</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <span data-scroll-top-mirror={scrollTop} hidden />
      </div>
    </div>
  );
}

function formatShortTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  // Explicitly calculate in UTC+8 (Asia/Shanghai) to guarantee identical output on SSR and Client
  const utc8Time = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const month = (utc8Time.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = utc8Time.getUTCDate().toString().padStart(2, "0");
  const hours = utc8Time.getUTCHours().toString().padStart(2, "0");
  const minutes = utc8Time.getUTCMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

function formatSourcePrice(price: ProductPoolItemV1["sourcePriceWire"]): string {
  if (!price) return "—";
  const amount = BigInt(price.amountMinor);
  const decimal = `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
  return price.currency === "CNY" ? `¥${decimal}` : `${decimal} ${price.currency}`;
}

