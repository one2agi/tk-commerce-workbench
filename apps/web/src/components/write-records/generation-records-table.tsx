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
        <p>暂无 AI 生成审计记录</p>
      </div>
    );
  }

  return (
    <div className="tk-write-records-table-wrap">
      <table className="tk-write-records-table">
        <thead>
          <tr>
            <th scope="col" style={{ width: "360px" }}>生成批次 / 商品</th>
            <th scope="col" style={{ width: "120px" }}>生成时间</th>
            <th scope="col" style={{ width: "220px" }}>调用线路 / 算力模型</th>
            <th scope="col" style={{ width: "160px" }}>出图结果</th>
            <th scope="col" style={{ textAlign: "right" }}>状态</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.batchId}>
              {/* 1. 批次 / 商品 */}
              <td>
                <div className="tk-write-records-product-title">
                  {item.title}
                </div>
                <div className="tk-write-records-meta-line">
                  <span style={{ fontWeight: 600, color: "#52525b" }}>批次: {item.batchId.slice(0, 14)}</span>
                  <span>·</span>
                  <span style={{ color: "#71717a" }}>{item.categoryKey}</span>
                </div>
              </td>

              {/* 2. 生成时间 */}
              <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "12px", color: "#71717a", whiteSpace: "nowrap" }} suppressHydrationWarning>
                {formatTime(item.createdAt)}
              </td>

              {/* 3. 调用线路 */}
              <td style={{ whiteSpace: "nowrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "6px", fontSize: "12px", fontFamily: "ui-monospace, monospace", background: "#f4f4f5", color: "#3f3f46", fontWeight: 600 }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "9999px", background: "#4f46e5" }} aria-hidden="true" />
                  {item.providerRoute}
                </span>
              </td>

              {/* 4. 出图结果 */}
              <td style={{ whiteSpace: "nowrap", fontFamily: "ui-monospace, monospace", fontSize: "12px" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "#18181b", fontWeight: 600 }}>
                    要 {item.requestedCount} · 成功 {item.successfulCount}
                  </span>
                  {item.successfulCount === item.requestedCount ? (
                    <span style={{ fontSize: "11px", padding: "1px 6px", borderRadius: "4px", background: "#ecfdf5", color: "#047857", fontWeight: 600 }}>
                      100% 满图
                    </span>
                  ) : (
                    <span style={{ fontSize: "11px", padding: "1px 6px", borderRadius: "4px", background: "#fffbeb", color: "#b45309", fontWeight: 600 }}>
                      部分成功
                    </span>
                  )}
                </div>
              </td>

              {/* 5. 状态 */}
              <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                {item.state === "succeeded" && (
                  <span className="tk-write-records-pill is-success">
                    <span className="tk-write-records-pill-dot" aria-hidden="true" />
                    已完成
                  </span>
                )}
                {item.state === "partial" && (
                  <span className="tk-write-records-pill is-queued">
                    <span className="tk-write-records-pill-dot" aria-hidden="true" />
                    部分出图
                  </span>
                )}
                {item.state === "generating" && (
                  <span className="tk-write-records-pill is-syncing">
                    <span className="tk-write-records-pill-dot" aria-hidden="true" />
                    生成中
                  </span>
                )}
                {item.state === "failed" && (
                  <span className="tk-write-records-pill is-failed">
                    <span className="tk-write-records-pill-dot" aria-hidden="true" />
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
