import type { TaskCenterItemV1 } from "@tk/contracts/read-models";
import { TaskTable } from "../../components/tasks/task-table";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

export function renderTasksPage(data: { items: TaskCenterItemV1[] }) {
  return <section aria-label="任务中心">
    <header className="tk-page-heading"><div><p>Operations</p><h1>任务中心</h1></div><span>{data.items.length} 个任务</span></header>
    <p>集中查看采集、素材、Listing、Canvas 与妙手同步；存在远端结果的任务只做对账，不重复发起费用操作。</p>
    <TaskTable items={data.items} />
  </section>;
}

export default async function TasksPage() {
  return renderTasksPage(await (await getServerServices()).tasks.list());
}
