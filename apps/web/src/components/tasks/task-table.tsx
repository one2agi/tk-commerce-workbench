import type { TaskCenterItemV1 } from "@tk/contracts/read-models";
import type { JobStatus } from "@tk/contracts/states";
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

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "排队",
  running: "运行中",
  paused: "暂停",
  needs_input: "需输入",
  ready: "完成",
  succeeded: "完成",
  failed: "失败"
};

function statusTone(status: JobStatus): string {
  switch (status) {
    case "running": return "is-tone-info";
    case "ready":
    case "succeeded": return "is-tone-success";
    case "paused": return "is-tone-amber";
    case "needs_input": return "is-tone-warning";
    case "failed": return "is-tone-danger";
    case "queued": return "is-tone-muted";
    default: return "is-tone-muted";
  }
}

function pauseReasonFor(item: TaskCenterItemV1): { text: string; isError: boolean } {
  if (item.pauseReason) return { text: item.pauseReason, isError: false };
  if (item.error?.safeMessage) return { text: item.error.safeMessage, isError: true };
  return { text: "—", isError: false };
}

export function TaskTable({ items }: { items: TaskCenterItemV1[] }) {
  return (
    <div className="tk-product-table tk-task-table">
      <div className="tk-task-table__scroll">
        <table>
          <thead><tr>
            <th scope="col">阶段</th>
            <th scope="col">任务</th>
            <th scope="col">状态</th>
            <th scope="col">尝试</th>
            <th scope="col">下次执行</th>
            <th scope="col">暂停/错误原因</th>
            <th scope="col">恢复操作</th>
          </tr></thead>
          <tbody>
            {items.length === 0
              ? <tr className="tk-task-table__empty-row">
                  <td colSpan={7} className="tk-task-table__empty">
                    <span className="tk-task-table__empty-title">暂无任务</span>
                    <span className="tk-task-table__empty-hint">采集源、素材归档、Listing 等阶段的运行与失败会汇总在这里</span>
                  </td>
                </tr>
              : items.map((item) => {
                  const reason = pauseReasonFor(item);
                  const status = item.status as JobStatus;
                  return <tr key={String(item.jobId)}>
                    <td>{GROUP_LABELS[item.kind] ?? item.kind}</td>
                    <td>
                      <strong>{String(item.jobId)}</strong>
                      <small>{item.revisionId ? String(item.revisionId) : "—"}</small>
                    </td>
                    <td>
                      <span className={`tk-pill tk-pill--status ${statusTone(status)}`}>
                        {STATUS_LABEL[status] ?? status}
                      </span>
                    </td>
                    <td><span className="tk-task-attempts">{item.attempt} / {item.maxAttempts}</span></td>
                    <td>{item.nextAttemptAt ?? "—"}</td>
                    <td>
                      <span className={`tk-task-table__pause-reason${reason.isError ? " tk-task-table__pause-reason--error" : ""}`}>
                        {reason.text}
                      </span>
                    </td>
                    <td>
                      <TaskRecoveryActions
                        taskId={String(item.jobId)}
                        status={String(item.status)}
                        errorKind={item.error?.kind ?? null}
                      />
                    </td>
                  </tr>;
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
