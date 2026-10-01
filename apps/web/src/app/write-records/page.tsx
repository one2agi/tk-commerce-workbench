import type { MiaoshouSyncStatusV1, WriteRecordsOverviewV1 } from "@tk/contracts/read-models";

import { getServerServices } from "../../server/composition";
import { WriteRecordsWorkspace } from "../../components/write-records/write-records-workspace";

export const dynamic = "force-dynamic";

export function renderWriteRecordsPage(data: WriteRecordsOverviewV1 | { items: ReadonlyArray<MiaoshouSyncStatusV1> }) {
  const normalizedData: WriteRecordsOverviewV1 = {
    items: data.items,
    metrics: "metrics" in data ? data.metrics : undefined,
    generationRecords: "generationRecords" in data ? data.generationRecords : undefined
  };

  return (
    <section aria-label="写入记录" className="min-h-[100dvh] bg-[#fafaf9]">
      <WriteRecordsWorkspace data={normalizedData} />
    </section>
  );
}

export default async function WriteRecordsPage() {
  return renderWriteRecordsPage(await (await getServerServices()).syncs.list());
}
