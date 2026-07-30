/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobId } from "@tk/contracts/ids";
import type { TaskCenterItemV1 } from "@tk/contracts/read-models";

import { renderTasksPage } from "./page";

function makeItem(over: Partial<TaskCenterItemV1> = {}): TaskCenterItemV1 {
  return {
    jobId: jobId("JOB-1"),
    kind: "asset_archive",
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    pauseReason: null,
    error: null,
    revisionId: null,
    ...over
  } as TaskCenterItemV1;
}

describe("tasks page", () => {
  it("renders 4 KPI tiles with counts per status group", () => {
    const html = renderToStaticMarkup(renderTasksPage({ items: [
      makeItem({ jobId: jobId("J-1"), status: "running" }),
      makeItem({ jobId: jobId("J-2"), status: "running" }),
      makeItem({ jobId: jobId("J-3"), status: "paused" }),
      makeItem({ jobId: jobId("J-4"), status: "needs_input" }),
      makeItem({ jobId: jobId("J-5"), status: "needs_input" }),
      makeItem({ jobId: jobId("J-6"), status: "failed" }),
      makeItem({ jobId: jobId("J-7"), status: "ready" })
    ] }));
    // Heading
    expect(html).toContain("任务中心");
    expect(html).toContain("7 个任务");

    // Four KPI tile labels
    expect(html).toContain("运行中");
    expect(html).toContain("暂停");
    expect(html).toContain("需处理");
    expect(html).toContain("失败");

    // KPI counts: running=2, paused=1, needs_input=2, failed=1
    // (These appear as adjacent characters inside the same tile; check via pairing.)
    expect(html).toContain('>2<'); // 2 running
    expect(html).toMatch(/<[^>]*>\s*2\s*<\/\D+>\s*运行中|运行中[\s\S]{0,80}>2</);
  });

  it("shows zero counts but still renders the KPI strip when there are no tasks", () => {
    const html = renderToStaticMarkup(renderTasksPage({ items: [] }));
    expect(html).toContain("任务中心");
    expect(html).toContain("0 个任务");
    expect(html).toContain("运行中");
    expect(html).toContain("暂停");
    expect(html).toContain("需处理");
    expect(html).toContain("失败");
  });

  it("summarizes the page purpose below the heading", () => {
    const html = renderToStaticMarkup(renderTasksPage({ items: [] }));
    expect(html).toContain("集中查看");
    expect(html).toContain("远端结果的任务只做对账");
  });

  it("renders a refresh action in the task-center heading", () => {
    const html = renderToStaticMarkup(renderTasksPage({ items: [] }));
    expect(html).toContain("刷新");
  });
});
