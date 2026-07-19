"use client";

import type { ChangeEvent, ReactElement, UIEvent } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import type { StageKey } from "./product-workbench.selectors";
import { canStartAutomation } from "./product-workbench.selectors";
import type { StartStatus } from "./product-workbench.state";

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
  processing: "处理中",
  review: "待确认",
  needs_attention: "需处理",
  synced: "已同步妙手"
};

function statusFor(item: ProductPoolItemV1): string {
  // Render the projected per-aggregate state, not a single status.
  // The Wave 1 workbench never exposes drag-to-change-status affordances.
  return [
    `采集:${item.miaoshouSource}`,
    `listing:${item.listing}`,
    `编辑:${item.miaoshouEdit}`
  ].join(" · ");
}

export function ProductTable({
  items,
  filtered,
  selectedIds,
  startStatusById,
  activeStage,
  onToggleSelection,
  onOpenDrawer,
  onScroll,
  scrollTop,
  onStart
}: Props): ReactElement {
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
              <th scope="col">源商品 ID</th>
              <th scope="col">标题</th>
              <th scope="col">状态投影</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const checked = selectedIds.has(String(item.productId));
              const startStatus = startStatusById.get(String(item.productId)) ?? "idle";
              const canStart = canStartAutomation(item);
              const startDisabled =
                startStatus === "pending" || startStatus === "success" || !canStart;
              const startText =
                startStatus === "pending"
                  ? "处理中"
                  : startStatus === "success"
                    ? "已开始"
                    : startStatus === "failure"
                      ? "重试处理"
                      : "开始处理";
              const blockedReason =
                !canStart && item.automation === "not_started"
                  ? item.sourceImageCount <= 0
                    ? "妙手原始数据没有可用图片"
                    : item.canonicalSuccessDetailId === null
                      ? "缺少妙手采集箱详情 ID"
                      : "采集尚未成功"
                  : null;
              return (
                <tr key={String(item.productId)} aria-selected={checked}>
                  <td>
                    <label className="tk-product-table__checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          startStatus === "pending" ||
                          (!checked && (!canStartAutomation(item) || startStatus === "success"))
                        }
                        aria-label={`选择商品 ${item.productId}`}
                        onChange={(_e: ChangeEvent<HTMLInputElement>) =>
                          onToggleSelection(String(item.productId))
                        }
                      />
                    </label>
                  </td>
                  <td>{String(item.productId)}</td>
                  <td>{item.canonicalSourceTitle ?? "—"}</td>
                  <td>{statusFor(item)}</td>
                  <td>
                    <div className="tk-product-table__actions">
                      <button
                        type="button"
                        aria-label={`查看详情 ${item.productId}`}
                        onClick={() => onOpenDrawer(String(item.productId))}
                      >
                        查看详情
                      </button>
                      <button
                        type="button"
                        aria-label={`${startText} ${item.productId}`}
                        disabled={startDisabled}
                        title={blockedReason ?? undefined}
                        onClick={() => onStart(String(item.productId))}
                      >
                        {startText}
                      </button>
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
