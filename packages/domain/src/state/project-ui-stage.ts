// Project per-aggregate states onto a friendly UI "stage" label and counts.
//
// Rules:
// - not_started is terminal when no paid service has been called.
// - collecting once a paid source tool begins (miaoshouSource not in {not_started, ...}).
// - approved once everything except miaoshou_edit is done AND approval = approved.
// - published once miaoshou_edit succeeded.
// - blocked whenever any axis is in a failed/result_unknown terminal state.
//
// Counts are *per-axis* — we never collapse into a single global status.

import type {
  ApprovalState,
  AssetArchiveState,
  AutomationState,
  CanvasState,
  ListingState,
  MiaoshouEditState,
  MiaoshouSourceState
} from "@tk/contracts";

export type UiStageLabel =
  | "not_started"
  | "collecting"
  | "asset_ready"
  | "approved"
  | "published"
  | "blocked";

export interface ProductAxes {
  readonly miaoshouSource: MiaoshouSourceState;
  readonly automation: AutomationState;
  readonly assetArchive: AssetArchiveState;
  readonly listing: ListingState;
  readonly canvas: CanvasState;
  readonly approval: ApprovalState;
  readonly miaoshouEdit: MiaoshouEditState;
}

const COLLECTING_STATES: ReadonlySet<MiaoshouSourceState> = new Set([
  "submitted",
  "pending",
  "success",
  "skipped_duplicate",
  "failed"
]);

const FAILED_TERMINAL: ReadonlyArray<string> = [
  "failed",
  "result_unknown",
  "needs_input",
  "needs_reconcile"
];

function isFailed(axis: string): boolean {
  return FAILED_TERMINAL.includes(axis);
}

export function projectUiStage(input: ProductAxes): { label: UiStageLabel } {
  const axesForBlocked: ReadonlyArray<{ value: string }> = [
    { value: input.miaoshouSource },
    { value: input.assetArchive },
    { value: input.listing },
    { value: input.canvas },
    { value: input.miaoshouEdit }
  ];
  if (axesForBlocked.some((a) => isFailed(a.value))) {
    return { label: "blocked" };
  }

  // published wins once miaoshou edit succeeded.
  if (input.miaoshouEdit === "succeeded" && input.approval === "approved") {
    return { label: "published" };
  }

  // approved once the product-side pipeline is ready AND approval = approved.
  const pipelineReady =
    input.assetArchive === "ready" &&
    input.listing === "ready" &&
    input.canvas === "succeeded";
  if (pipelineReady && input.approval === "approved") {
    return { label: "approved" };
  }

  if (input.assetArchive === "ready") {
    return { label: "asset_ready" };
  }

  if (COLLECTING_STATES.has(input.miaoshouSource)) {
    return { label: "collecting" };
  }

  if (input.automation !== "not_started") {
    return { label: "collecting" };
  }

  return { label: "not_started" };
}

export interface StageCounts {
  not_started: number;
  collecting: number;
  blocked: number;
  assetReady: number;
  approved: number;
  published: number;
}

export function projectStageCounts(rows: ReadonlyArray<ProductAxes>): StageCounts {
  const counts: StageCounts = {
    not_started: 0,
    collecting: 0,
    blocked: 0,
    assetReady: 0,
    approved: 0,
    published: 0
  };
  for (const row of rows) {
    const { label } = projectUiStage(row);
    switch (label) {
      case "not_started":
        counts.not_started++;
        break;
      case "collecting":
        counts.collecting++;
        break;
      case "blocked":
        counts.blocked++;
        break;
      case "asset_ready":
        counts.assetReady++;
        break;
      case "approved":
        counts.approved++;
        break;
      case "published":
        counts.published++;
        break;
    }
  }
  return counts;
}
