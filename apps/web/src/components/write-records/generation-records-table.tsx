import type { ReactElement } from "react";
import type { GenerationAuditRecordV1 } from "@tk/contracts/read-models";

export function GenerationRecordsTable({
  items
}: {
  items: ReadonlyArray<GenerationAuditRecordV1>;
}): ReactElement {
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
        <p className="text-sm">暂无 AI 生成审计记录</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-black/5 text-zinc-400 font-mono text-[11px] tracking-wider uppercase">
            <th scope="col" className="py-3 px-4 font-medium">生成批次 / 商品</th>
            <th scope="col" className="py-3 px-4 font-medium">生成时间</th>
            <th scope="col" className="py-3 px-4 font-medium">调用线路 / 算力模型</th>
            <th scope="col" className="py-3 px-4 font-medium">出图结果</th>
            <th scope="col" className="py-3 px-4 font-medium">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-black/5 text-zinc-700">
          {items.map((item) => (
            <tr key={item.batchId} className="hover:bg-zinc-50/80 transition-colors duration-150">
              {/* 1. 批次 / 商品 */}
              <td className="py-3.5 px-4 max-w-[340px]">
                <div className="font-medium text-zinc-900 truncate tracking-tight text-[13px]">
                  {item.title}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400 font-mono">
                  <span className="text-zinc-600 font-medium">批次: {item.batchId.slice(0, 14)}</span>
                  <span>·</span>
                  <span className="text-zinc-500">{item.categoryKey}</span>
                </div>
              </td>

              {/* 2. 生成时间 */}
              <td className="py-3.5 px-4 font-mono text-xs text-zinc-500 whitespace-nowrap">
                {formatTime(item.createdAt)}
              </td>

              {/* 3. 调用线路 */}
              <td className="py-3.5 px-4 whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-zinc-100 text-zinc-700 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
                  {item.providerRoute}
                </span>
              </td>

              {/* 4. 出图结果 */}
              <td className="py-3.5 px-4 whitespace-nowrap font-mono text-xs">
                <div className="inline-flex items-center gap-2">
                  <span className="text-zinc-700 font-semibold">
                    要 {item.requestedCount} · 成功 {item.successfulCount}
                  </span>
                  {item.successfulCount === item.requestedCount ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">
                      100% 满图
                    </span>
                  ) : (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                      部分成功
                    </span>
                  )}
                </div>
              </td>

              {/* 5. 状态 */}
              <td className="py-3.5 px-4 whitespace-nowrap">
                {item.state === "succeeded" && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    已完成
                  </span>
                )}
                {item.state === "partial" && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-600/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                    部分出图
                  </span>
                )}
                {item.state === "generating" && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-600/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
                    生成中
                  </span>
                )}
                {item.state === "failed" && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 ring-1 ring-rose-600/10">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500" aria-hidden="true" />
                    生成失败
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
