"use client";

import type { ReactElement } from "react";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

type Props = Readonly<{
  item: ProductPoolItemV1 | null;
  open: boolean;
  startButtonLabel: string;
  onClose: () => void;
  onStart: (productId: string) => void;
}>;

export function ProductDrawer({
  item,
  open,
  startButtonLabel,
  onClose,
  onStart
}: Props): ReactElement {
  if (!open || !item) {
    return (
      <aside
        aria-label="商品详情"
        aria-hidden="true"
        className="tk-product-drawer is-closed"
        role="dialog"
      />
    );
  }
  const productId = String(item.productId);
  return (
    <aside
      aria-label="商品详情"
      className="tk-product-drawer"
      role="dialog"
      aria-modal="false"
    >
      <header>
        <h2>{item.canonicalSourceTitle ?? productId}</h2>
        <button type="button" aria-label="关闭详情" onClick={onClose}>
          关闭详情
        </button>
      </header>
      <dl>
        <dt>源商品 ID</dt>
        <dd>{productId}</dd>
        <dt>目标标题</dt>
        <dd>{item.targetTitle ?? "—"}</dd>
        <dt>目标价格</dt>
        <dd>{item.priceWire ? `${item.priceWire.amountMinor} ${item.priceWire.currency}` : "—"}</dd>
        <dt>采集状态</dt>
        <dd>{item.miaoshouSource}</dd>
        <dt>listing 状态</dt>
        <dd>{item.listing}</dd>
        <dt>妙手编辑状态</dt>
        <dd>{item.miaoshouEdit}</dd>
      </dl>
      <footer>
        <button
          type="button"
          aria-label={`${startButtonLabel} ${productId}`}
          onClick={() => onStart(productId)}
          disabled={item.automation !== "not_started" && item.automation !== "needs_input"}
        >
          {startButtonLabel}
        </button>
      </footer>
    </aside>
  );
}