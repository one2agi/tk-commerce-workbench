import type { TaskCenterItemV1 } from "@tk/contracts/read-models";

import { TaskTable } from "../../components/tasks/task-table";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

type Tile = Readonly<{
  key: "running" | "paused" | "needs_input" | "failed";
  label: string;
  hint: string;
  tone: string;
  count: number;
}>;

function summarize(items: ReadonlyArray<TaskCenterItemV1>): ReadonlyArray<Tile> {
  const count = (status: TaskCenterItemV1["status"]): number =>
    items.reduce((n, it) => n + (it.status === status ? 1 : 0), 0);
  return [
    { key: "running",     label: "运行中", hint: "正在执行",       tone: "is-tone-info",    count: count("running") },
    { key: "paused",      label: "暂停",   hint: "等待继续",       tone: "is-tone-amber",   count: count("paused") },
    { key: "needs_input", label: "需处理", hint: "需输入/对账",   tone: "is-tone-warning", count: count("needs_input") },
    { key: "failed",      label: "失败",   hint: "待重试或核查",   tone: "is-tone-danger",  count: count("failed") }
  ];
}

export function renderTasksPage(data: { items: TaskCenterItemV1[] }) {
  const tiles = summarize(data.items);
  return <section aria-label="任务中心">
    <header className="tk-page-heading">
      <div><p>Operations</p><h1>任务中心</h1></div>
      <div className="tk-task-heading-actions">
        <span>{data.items.length} 个任务</span>
        <form action="/tasks" method="get">
          <button type="submit" className="tk-button tk-button--secondary">刷新</button>
        </form>
      </div>
    </header>
    <p>集中查看采集、素材、Listing、Canvas 与妙手同步；存在远端结果的任务只做对账，不重复发起费用操作。</p>

    <div className="tk-kpi-strip" aria-label="任务状态汇总">
      {tiles.map((t) => <div key={t.key} className={`tk-kpi-tile ${t.tone}`}>
        <span className="tk-kpi-tile__count">{t.count}</span>
        <span className="tk-kpi-tile__label">{t.label}</span>
        <span className="tk-kpi-tile__hint">{t.hint}</span>
      </div>)}
    </div>

    <TaskTable items={data.items} />
  </section>;
}

export default async function TasksPage() {
  return renderTasksPage(await (await getServerServices()).tasks.list());
}
