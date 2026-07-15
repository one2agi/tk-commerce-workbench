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
  | "pending"
  | "processing"
  | "review"
  | "needs_attention"
  | "synced";

export interface ProductAxes {
  readonly miaoshouSource: MiaoshouSourceState;
  readonly automation: AutomationState;
  readonly assetArchive: AssetArchiveState;
  readonly listing: ListingState;
  readonly canvas: CanvasState;
  readonly approval: ApprovalState;
  readonly miaoshouEdit: MiaoshouEditState;
  readonly hasUsableCanvasOutputs?: boolean;
}

function needsAttention(input: ProductAxes): boolean {
  return (
    input.miaoshouSource === "failed" ||
    input.automation === "needs_input" ||
    input.automation === "failed" ||
    input.automation === "cancelled" ||
    input.assetArchive === "partial" ||
    input.assetArchive === "failed" ||
    input.listing === "needs_input" ||
    input.listing === "failed" ||
    input.canvas === "failed" ||
    (input.canvas === "partial" && !input.hasUsableCanvasOutputs) ||
    input.approval === "invalidated" ||
    input.miaoshouEdit === "result_unknown" ||
    input.miaoshouEdit === "failed"
  );
}

function isProcessing(input: ProductAxes): boolean {
  return (
    input.miaoshouSource === "submitted" ||
    input.miaoshouSource === "pending" ||
    input.automation === "queued" ||
    input.automation === "running" ||
    input.automation === "paused" ||
    input.automation === "ready" ||
    input.assetArchive === "downloading" ||
    input.listing === "generating" ||
    input.canvas === "queued" ||
    input.canvas === "running" ||
    input.approval === "approved" ||
    input.miaoshouEdit === "queued" ||
    input.miaoshouEdit === "syncing"
  );
}

export function projectUiStage(input: ProductAxes): { label: UiStageLabel } {
  if (input.miaoshouEdit === "succeeded") {
    return { label: "synced" };
  }

  if (needsAttention(input)) {
    return { label: "needs_attention" };
  }

  const reviewReady =
    input.assetArchive === "ready" &&
    input.listing === "ready" &&
    (input.canvas === "succeeded" ||
      (input.canvas === "partial" && input.hasUsableCanvasOutputs === true)) &&
    input.approval === "unapproved";
  if (reviewReady) {
    return { label: "review" };
  }

  if (isProcessing(input)) {
    return { label: "processing" };
  }

  return { label: "pending" };
}

export interface StageCounts {
  pending: number;
  processing: number;
  review: number;
  needsAttention: number;
  synced: number;
}

export function projectStageCounts(rows: ReadonlyArray<ProductAxes>): StageCounts {
  const counts: StageCounts = {
    pending: 0,
    processing: 0,
    review: 0,
    needsAttention: 0,
    synced: 0
  };

  for (const row of rows) {
    switch (projectUiStage(row).label) {
      case "pending":
        counts.pending++;
        break;
      case "processing":
        counts.processing++;
        break;
      case "review":
        counts.review++;
        break;
      case "needs_attention":
        counts.needsAttention++;
        break;
      case "synced":
        counts.synced++;
        break;
    }
  }

  return counts;
}
