import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderWriteRecordsPage } from "./page";

describe("write records page", () => {
  it("renders Miaoshou write records without TikTok publish actions", () => {
    const html = renderToStaticMarkup(renderWriteRecordsPage({
      items: [{
        syncId: "sync-1",
        approvalSnapshotId: "approval-1",
        state: "succeeded",
        remoteDetailId: "3814610360" as never,
        lastReconciledAt: "2026-07-22T10:00:00.000Z",
        error: null
      }]
    }));
    expect(html).toContain("写入记录");
    expect(html).toContain("sync-1");
    expect(html).toContain("approval-1");
    expect(html).toContain("3814610360");
    expect(html).toContain("succeeded");
    expect(html).not.toContain("发布 TikTok");
  });
});
