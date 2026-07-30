import type { MiaoshouSyncStatusV1 } from "@tk/contracts/read-models";

import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

export function renderWriteRecordsPage(data: { items: ReadonlyArray<MiaoshouSyncStatusV1> }) {
  return (
    <section aria-label="写入记录">
      <header className="tk-page-heading">
        <div>
          <p>Miaoshou</p>
          <h1>写入记录</h1>
        </div>
      </header>
      <p>这里展示确认后写回妙手 canonical 公共采集箱商品的记录，不展示 TikTok 发布入口。</p>
      <table>
        <thead>
          <tr>
            <th scope="col">同步 ID</th>
            <th scope="col">审批快照</th>
            <th scope="col">状态</th>
            <th scope="col">妙手详情 ID</th>
            <th scope="col">最近对账</th>
            <th scope="col">错误</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.syncId}>
              <td>{item.syncId}</td>
              <td>{item.approvalSnapshotId}</td>
              <td>{item.state}</td>
              <td>{item.remoteDetailId ?? "—"}</td>
              <td>{item.lastReconciledAt ?? "—"}</td>
              <td>{item.error?.safeMessage ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function WriteRecordsPage() {
  return renderWriteRecordsPage(await (await getServerServices()).syncs.list());
}
