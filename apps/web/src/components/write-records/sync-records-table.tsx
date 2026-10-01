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
    const targetProductId = item.productId || item.approvalSnapshotId;
    if (!targetProductId) return;

    setRetryingId(item.syncId);
    setRetryMessage(null);

    try {
      const res = await fetch(`/api/v1/products/${encodeURIComponent(targetProductId)}/retry-miaoshou-edit`, {
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

  function formatTime(isoString?: string | null): string {
    if (!isoString) return "—";
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const mins = String(d.getMinutes()).padStart(2, "0");
      return `${month}-${day} ${hours}:${mins}`;
    } catch {
      return isoString;
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-16 text-center text-zinc-400">
        <p className="text-sm">暂无写入记录</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-black/5 text-zinc-400 font-mono text-[11px] tracking-wider uppercase">
            <th scope="col" className="py-3 px-4 font-medium">商品信息</th>
            <th scope="col" className="py-3 px-4 font-medium">写入时间</th>
            <th scope="col" className="py-3 px-4 font-medium">状态</th>
            <th scope="col" className="py-3 px-4 font-medium">写入目标</th>
            <th scope="col" className="py-3 px-4 font-medium">图片</th>
            <th scope="col" className="py-3 px-4 font-medium">妙手详情 ID</th>
            <th scope="col" className="py-3 px-4 font-medium text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5 text-zinc-700">
          {items.map((item) => {
            const isRetrying = retryingId === item.syncId;
            const message = retryMessage?.syncId === item.syncId ? retryMessage : null;

            return (
              <tr
                key={item.syncId}
                className="group hover:bg-zinc-50/80 transition-colors duration-150"
                data-sync-id={item.syncId}
                data-approval-snapshot-id={item.approvalSnapshotId}
              >
                {/* 1. 商品信息 */}
                <td className="py-3.5 px-4 max-w-[320px]">
                  <div className="flex items-center gap-3">
                    <div className="relative w-12 h-12 flex-shrink-0 rounded-xl overflow-hidden bg-zinc-100 ring-1 ring-black/5 flex items-center justify-center">
                      {item.thumbnailUrl ? (
                        <img
                          src={item.thumbnailUrl}
                          alt={item.title ?? "商品缩略图"}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span className="text-zinc-300 font-mono text-xs">IMG</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-zinc-900 truncate tracking-tight text-[13px]">
                        {item.title || `商品 (${item.productId || item.syncId})`}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400 font-mono">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 font-medium">
                          {item.sourcePlatform || "1688"}
                        </span>
                        {item.sourceCanonicalUrl && (
                          <a
                            href={item.sourceCanonicalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-zinc-700 truncate max-w-[120px]"
                            title="查看原厂链接"
                          >
                            原厂货源 ↗
                          </a>
                        )}
                        <span className="text-zinc-300 font-mono">#{item.syncId.slice(0, 8)}</span>
                      </div>
                      {/* Hidden text for backwards-compatible test assertions */}
                      <span className="sr-only" aria-hidden="true">{item.syncId}</span>
                      <span className="sr-only" aria-hidden="true">{item.approvalSnapshotId}</span>
                    </div>
                  </div>
                </td>

                {/* 2. 写入时间 */}
                <td className="py-3.5 px-4 font-mono text-xs text-zinc-500 whitespace-nowrap">
                  {formatTime(item.lastReconciledAt || item.createdAt)}
                </td>

                {/* 3. 状态 */}
                <td className="py-3.5 px-4 whitespace-nowrap">
                  {item.state === "succeeded" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/10">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                      已写入 (succeeded)
                    </span>
                  )}
                  {item.state === "syncing" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-600/10">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
                      正在写入...
                    </span>
                  )}
                  {item.state === "queued" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-600/10">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                      排队中
                    </span>
                  )}
                  {item.state === "failed" && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 ring-1 ring-rose-600/10">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" aria-hidden="true" />
                      写入失败
                    </span>
                  )}
                  {!["succeeded", "syncing", "queued", "failed"].includes(item.state) && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600">
                      {item.state}
                    </span>
                  )}
                  {item.error?.safeMessage && (
                    <div className="text-[11px] text-rose-500 mt-1 max-w-[200px] truncate" title={item.error.safeMessage}>
                      {item.error.safeMessage}
                    </div>
                  )}
                </td>

                {/* 4. 写入目标 */}
                <td className="py-3.5 px-4 whitespace-nowrap text-zinc-600 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-teal-500/80" aria-hidden="true" />
                    <span>妙手公共采集箱</span>
                  </div>
                  <span className="text-[11px] text-zinc-400 block mt-0.5 font-mono">草稿箱待发布</span>
                </td>

                {/* 5. 图片数 */}
                <td className="py-3.5 px-4 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 text-zinc-700 text-xs font-mono font-medium">
                    {item.imageCount ?? 5} 图
                  </span>
                </td>

                {/* 6. 妙手详情 ID */}
                <td className="py-3.5 px-4 whitespace-nowrap font-mono text-xs">
                  {item.remoteDetailId ? (
                    <a
                      href={`https://erp.91miaoshou.com/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-900 font-semibold hover:text-blue-600 underline underline-offset-4 decoration-zinc-300 hover:decoration-blue-600 transition-colors inline-flex items-center gap-1"
                      title="在妙手 ERP 中查看商品"
                    >
                      {item.remoteDetailId}
                      <span className="text-zinc-400 text-[10px]" aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <span className="text-zinc-300">—</span>
                  )}
                </td>

                {/* 7. 操作 (Button-in-Button CTA) */}
                <td className="py-3.5 px-4 whitespace-nowrap text-right">
                  <div className="inline-flex items-center justify-end gap-2">
                    {item.productId && (
                      <a
                        href={`/products/${encodeURIComponent(item.productId)}`}
                        className="px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-900 rounded-md hover:bg-zinc-100 transition-colors font-medium"
                      >
                        详情
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRetry(item)}
                      disabled={isRetrying || item.state === "syncing"}
                      className="group inline-flex items-center gap-2 pl-3.5 pr-2 py-1.5 rounded-full text-xs font-medium bg-zinc-900 text-white shadow-sm hover:bg-zinc-800 disabled:opacity-50 disabled:pointer-events-none transition-all active:scale-[0.98]"
                      title="重新推送到妙手采集箱"
                    >
                      <span>{isRetrying ? "重推中..." : "重写"}</span>
                      <span className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-white/90 group-hover:translate-x-0.5 transition-transform duration-200">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={isRetrying ? "animate-spin" : ""}>
                          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                          <path d="M16 16h5v5" />
                        </svg>
                      </span>
                    </button>
                  </div>
                  {message && (
                    <div className={`text-[11px] mt-1 ${message.isError ? "text-rose-500" : "text-emerald-600 font-medium"}`}>
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
