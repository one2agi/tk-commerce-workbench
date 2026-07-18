/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobId } from "@tk/contracts/ids";
import type { TaskCenterItemV1 } from "@tk/contracts/read-models";
import type { JobStatus } from "@tk/contracts/states";

import { TaskTable } from "./task-table";

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

const TONE_PAIRS: Array<[JobStatus, string]> = [
  ["running", "is-tone-info"],
  ["queued", "is-tone-muted"],
  ["paused", "is-tone-amber"],
  ["needs_input", "is-tone-warning"],
  ["ready", "is-tone-success"],
  ["succeeded", "is-tone-success"],
  ["failed", "is-tone-danger"]
];

describe("TaskTable", () => {
  it.each(TONE_PAIRS)("applies a status tone for %s", (status, toneClass) => {
    const html = renderToStaticMarkup(<TaskTable items={[makeItem({ jobId: jobId(`J-${status}`), status })]} />);
    expect(html.toLowerCase()).toContain(toneClass);
    expect(html).toContain("J-" + status);
  });

  it("renders pause reason text in a normal cell when not an error", () => {
    const html = renderToStaticMarkup(<TaskTable items={[makeItem({
      jobId: jobId("J-paused"),
      status: "paused",
      pauseReason: "等待妙手动账"
    })]} />);
    expect(html).toContain("等待妙手动账");
    // not flagged as the error-styled cell
    expect(html.toLowerCase()).not.toContain("tk-task-table__pause-reason--error");
  });

  it("renders error safeMessage with an error-flavored cell when job has failed", () => {
    const html = renderToStaticMarkup(<TaskTable items={[makeItem({
      jobId: jobId("J-failed"),
      status: "failed",
      error: { kind: "retryable", code: "miaoshou_timeout", safeMessage: "妙手 API 超时" }
    })]} />);
    expect(html).toContain("妙手 API 超时");
    expect(html.toLowerCase()).toContain("tk-task-table__pause-reason--error");
  });

  it("keeps the table skeleton when there are no items (no log-style alert)", () => {
    const html = renderToStaticMarkup(<TaskTable items={[]} />);
    const lowered = html.toLowerCase();
    expect(html).toContain("任务");
    expect(lowered).toContain("<th");
    expect(lowered).toContain("colspan");
    expect(html).toContain("tk-task-table__empty");
    expect(html).toContain("暂无任务");
  });

  it("renders the phase column using a human label, not the raw kind", () => {
    const html = renderToStaticMarkup(<TaskTable items={[makeItem({ jobId: jobId("J-collect"), kind: "miaoshou_collect" })]} />);
    // GROUP_LABELS maps miaoshou_collect → "采集"
    expect(html).toContain("采集");
  });
});
