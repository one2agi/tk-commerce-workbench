import type { TaskCenterItemV1 } from "@tk/contracts/read-models";
import { TaskRecoveryActions } from "./task-recovery-actions";

const GROUP_LABELS: Record<string, string> = {
  miaoshou_collect: "采集",
  asset_archive: "素材归档",
  listing_generate: "Listing",
  pricing_calculate: "定价",
  template_match: "模板",
  image_select: "选图",
  canvas_generate: "Canvas",
  final_preview: "审核预览",
  miaoshou_edit: "妙手同步"
};

export function TaskTable({ items }: { items: TaskCenterItemV1[] }) {
  return <div className="tk-table-wrap"><table className="tk-task-table">
    <thead><tr><th>阶段</th><th>任务</th><th>状态</th><th>尝试</th><th>下次执行</th><th>暂停/错误原因</th><th>恢复操作</th></tr></thead>
    <tbody>{items.map((item) => <tr key={String(item.jobId)}>
      <td>{GROUP_LABELS[item.kind] ?? item.kind}</td>
      <td><strong>{String(item.jobId)}</strong><small>{item.revisionId ? String(item.revisionId) : "—"}</small></td>
      <td>{item.status}</td>
      <td>{item.attempt} / {item.maxAttempts}</td>
      <td>{item.nextAttemptAt ?? "—"}</td>
      <td>{item.pauseReason ?? item.error?.safeMessage ?? "—"}</td>
      <td><TaskRecoveryActions taskId={String(item.jobId)} status={item.status} errorKind={item.error?.kind ?? null} /></td>
    </tr>)}</tbody>
  </table></div>;
}
