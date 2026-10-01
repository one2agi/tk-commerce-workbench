"use client";

import { useState, type ReactElement } from "react";
import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";

export function SyncRecordsTable({
  items,
  onRetrySuccess
}: {
  items: ReadonlyArray<MiaoshouSyncStatusV1>;
  onRetrySuccess?: () => void;
}): ReactElement {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<{ syncId: string; text: string; isError?: boolean } | null>(null);

  async function handleRetry(item: MiaoshouSyncStatusV1) {
    if (!item.productId) return;

    setRetryingId(item.syncId);
    setRetryMessage(null);

    try {
      const res = await fetch(`/api/v1/products/${encodeURIComponent(item.productId)}/retry-miaoshou-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      if (!res.ok) {
        const errorJson = await res.json().catch(() => ({}));
        throw new Error(errorJson.message || `重推失败 (${res.status})`);
      }

      setRetryMessage({ syncId: item.syncId, text: "已重新触发写入任务，正在同步..." });
      if (onRetrySuccess) {
        onRetrySuccess();
      }
    } catch (err) {
      setRetryMessage({
        syncId: item.syncId,
        text: err instanceof Error ? err.message : "重推失败",
        isError: true
      });
    } finally {
      setRetryingId(null);
    }
  }

  function formatStateText(state: string): string {
    switch (state) {
      case "succeeded":
        return "已写入";
      case "syncing":
        return "正在写入";
      case "queued":
        return "排队中";
      case "failed":
        return "写入失败";
      case "result_unknown":
        return "待核验";
      case "not_started":
        return "未开始";
      default:
        return "处理中";
    }
  }

  function formatTime(isoString?: string | null): string {
    if (!isoString) return "—";
    try {
      const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (match) {
        return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
      }
      return isoString;
    } catch {
      return isoString;
    }
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: "48px 0", textAlign: "center", color: "#a1a1aa", fontSize: "14px" }}>
        <p>暂无写入记录</p>
      </div>
    );
  }

  return (
    <div className="tk-write-records-table-wrap">
      <table className="tk-write-records-table">
        <thead>
          <tr>
            <th scope="col" style={{ width: "320px" }}>商品信息</th>
            <th scope="col" style={{ width: "110px" }}>写入时间</th>
            <th scope="col" style={{ width: "160px" }}>状态</th>
            <th scope="col" style={{ width: "150px" }}>写入目标</th>
            <th scope="col" style={{ width: "90px" }}>图片</th>
            <th scope="col" style={{ width: "130px" }}>妙手详情 ID</th>
            <th scope="col" style={{ textAlign: "right" }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isRetrying = retryingId === item.syncId;
            const message = retryMessage?.syncId === item.syncId ? retryMessage : null;

            return (
              <tr
                key={item.syncId}
                data-sync-id={item.syncId}
                data-approval-snapshot-id={item.approvalSnapshotId}
                data-state={item.state}
              >
                {/* 1. 商品信息 */}
                <td>
                  <div className="tk-write-records-product-cell">
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt={item.title ?? "商品缩略图"}
                        className="tk-write-records-thumb"
                        loading="lazy"
                        onError={(e) => {
                          // Hide broken image and fallback to placeholder
                          (e.currentTarget as HTMLElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="tk-write-records-thumb-placeholder">
                        <span>IMG</span>
                      </div>
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        className="tk-write-records-product-title"
                        title={item.title ?? undefined}
                      >
                        {item.title || "跨境商品"}
                      </div>
                      <div className="tk-write-records-meta-line">
                        <span className="tk-write-records-platform-badge">
                          {item.sourcePlatform || "1688"}
                        </span>
                        {item.sourceCanonicalUrl && (
                          <a
                            href={item.sourceCanonicalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tk-write-records-source-link"
                            title="查看原厂链接"
                          >
                            原厂货源 ↗
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </td>

                {/* 2. 写入时间 */}
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "12px", color: "#71717a", whiteSpace: "nowrap" }} suppressHydrationWarning>
                  {formatTime(item.lastReconciledAt || item.createdAt)}
                </td>

                {/* 3. 状态 (纯中文清晰展示) */}
                <td style={{ whiteSpace: "nowrap" }}>
                  {item.state === "succeeded" && (
                    <span className="tk-write-records-pill is-success">
                      <span className="tk-write-records-pill-dot" aria-hidden="true" />
                      已写入
                    </span>
                  )}
                  {item.state === "syncing" && (
                    <span className="tk-write-records-pill is-syncing">
                      <span className="tk-write-records-pill-dot" aria-hidden="true" />
                      正在写入
                    </span>
                  )}
                  {item.state === "queued" && (
                    <span className="tk-write-records-pill is-queued">
                      <span className="tk-write-records-pill-dot" aria-hidden="true" />
                      排队中
                    </span>
                  )}
                  {item.state === "failed" && (
                    <span className="tk-write-records-pill is-failed">
                      <span className="tk-write-records-pill-dot" aria-hidden="true" />
                      写入失败
                    </span>
                  )}
                  {!["succeeded", "syncing", "queued", "failed"].includes(item.state) && (
                    <span className="tk-write-records-pill" style={{ background: "#f4f4f5", color: "#52525b" }}>
                      {formatStateText(item.state)}
                    </span>
                  )}
                  {item.error?.safeMessage && (
                    <div style={{ fontSize: "11px", color: "#e11d48", marginTop: "4px", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.error.safeMessage}>
                      {item.error.safeMessage}
                    </div>
                  )}
                </td>

                {/* 4. 写入目标 */}
                <td style={{ whiteSpace: "nowrap", fontSize: "12px", color: "#52525b" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "9999px", background: "#0d9488" }} aria-hidden="true" />
                    <span style={{ fontWeight: 600 }}>妙手公共采集箱</span>
                  </div>
                  <span style={{ fontSize: "11px", color: "#a1a1aa", display: "block", marginTop: "2px", fontFamily: "ui-monospace, monospace" }}>
                    草稿箱待发布
                  </span>
                </td>

                {/* 5. 图片数 */}
                <td style={{ whiteSpace: "nowrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "6px", background: "#f4f4f5", color: "#3f3f46", fontSize: "11.5px", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                    {item.imageCount ?? 5} 图
                  </span>
                </td>

                {/* 6. 妙手详情 ID */}
                <td style={{ whiteSpace: "nowrap", fontFamily: "ui-monospace, monospace", fontSize: "12px" }}>
                  {item.remoteDetailId ? (
                    <a
                      href="https://erp.91miaoshou.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tk-write-records-detail-link"
                      title="在妙手 ERP 中查看商品"
                    >
                      {item.remoteDetailId}
                      <span style={{ fontSize: "10px", color: "#a1a1aa" }} aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <span style={{ color: "#d4d4d8" }}>—</span>
                  )}
                </td>

                {/* 7. 操作 (Button-in-Button CTA) */}
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
                    {item.productId && (
                      <a
                        href={`/products/${encodeURIComponent(item.productId)}`}
                        style={{ padding: "4px 8px", fontSize: "12px", color: "#71717a", borderRadius: "6px", textDecoration: "none", fontWeight: 500 }}
                      >
                        详情
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRetry(item)}
                      disabled={isRetrying || item.state === "syncing" || item.state === "succeeded" || !item.productId}
                      className="tk-btn-retry"
                      title={
                        item.state === "succeeded"
                          ? "该商品已成功写入妙手，无需重写"
                          : !item.productId
                            ? "无商品ID关联，无法重写"
                            : "重新推送到妙手采集箱"
                      }
                    >
                      <span>{isRetrying ? "重推中..." : "重写"}</span>
                      <span className="tk-btn-retry__icon">
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ animation: isRetrying ? "tk-spin 1s linear infinite" : "none" }}>
                          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                          <path d="M16 16h5v5" />
                        </svg>
                      </span>
                    </button>
                  </div>
                  {message && (
                    <div style={{ fontSize: "11px", marginTop: "4px", color: message.isError ? "#e11d48" : "#059669", fontWeight: 500 }}>
                      {message.text}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
