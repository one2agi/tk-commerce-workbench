import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import {
  projectUiStage,
  type UiStageLabel
} from "@tk/domain/state/project-ui-stage";

export type ProductPoolItem = ProductPoolItemV1;
export type StageKey = "all" | UiStageLabel;
export type AutomationProgressNode = Readonly<{
  key: "collect" | "listing" | "canvas" | "edit";
  label: string;
  state: "pending" | "running" | "ready" | "failed";
}>;

export type StageCard = Readonly<{
  key: StageKey;
  label: string;
  count: number;
}>;

export type StageOverview = Readonly<Record<StageKey, StageCard>>;

export const STAGE_ORDER: ReadonlyArray<StageKey> = [
  "all",
  "pending",
  "processing",
  "review",
  "needs_attention",
  "synced"
];

const STAGE_LABEL: Readonly<Record<StageKey, string>> = {
  all: "全部",
  pending: "待处理",
  processing: "处理中",
  review: "待确认",
  needs_attention: "需处理",
  synced: "已同步妙手"
};

export function productStage(item: ProductPoolItem): UiStageLabel {
  return projectUiStage({
    miaoshouSource: item.miaoshouSource,
    automation: item.automation,
    assetArchive: item.assetArchive,
    listing: item.listing,
    canvas: item.canvas,
    approval: item.approval,
    miaoshouEdit: item.miaoshouEdit,
    hasUsableCanvasOutputs: item.usableCanvasOutputCount > 0
  }).label;
}

export function canStartAutomation(item: ProductPoolItem): boolean {
  return (
    item.automation === "not_started" &&
    (item.miaoshouSource === "success" || item.miaoshouSource === "skipped_duplicate") &&
    item.canonicalSuccessDetailId !== null &&
    item.imageCount > 0
  );
}

export function buildAutomationProgress(item: ProductPoolItem): AutomationProgressNode[] {
  const collect: AutomationProgressNode["state"] = item.miaoshouSource === "success" || item.miaoshouSource === "skipped_duplicate"
    ? "ready"
    : item.miaoshouSource === "submitted" || item.miaoshouSource === "pending"
      ? "running"
      : item.miaoshouSource === "failed"
        ? "failed"
        : "pending";
  const listing: AutomationProgressNode["state"] = item.listing === "ready"
    ? "ready"
    : item.listing === "failed" || item.listing === "needs_input" || item.assetArchive === "failed"
      ? "failed"
      : item.listing === "generating" || item.assetArchive === "downloading"
        ? "running"
        : "pending";
  const canvas: AutomationProgressNode["state"] = item.canvas === "succeeded" || item.canvas === "partial"
    ? "ready"
    : item.canvas === "running" || item.canvas === "queued"
      ? "running"
      : item.canvas === "failed"
        ? "failed"
        : "pending";
  const edit: AutomationProgressNode["state"] = item.miaoshouEdit === "succeeded"
    ? "ready"
    : item.miaoshouEdit === "syncing"
      ? "running"
      : item.miaoshouEdit === "failed" || item.miaoshouEdit === "result_unknown"
        ? "failed"
        : "pending";
  return [
    { key: "collect", label: "采集", state: collect },
    { key: "listing", label: "Listing", state: listing },
    { key: "canvas", label: "Canvas", state: canvas },
    { key: "edit", label: "妙手编辑", state: edit }
  ];
}

export function buildStageOverview(items: ReadonlyArray<ProductPoolItem>): StageOverview {
  const counts: Record<StageKey, number> = {
    all: items.length,
    pending: 0,
    processing: 0,
    review: 0,
    needs_attention: 0,
    synced: 0
  };
  for (const item of items) counts[productStage(item)]++;

  return Object.fromEntries(
    STAGE_ORDER.map((key) => [
      key,
      { key, label: `${STAGE_LABEL[key]}（${counts[key]}）`, count: counts[key] }
    ])
  ) as StageOverview;
}

export function applyStageFilter(
  items: ReadonlyArray<ProductPoolItem>,
  stage: StageKey
): ProductPoolItem[] {
  if (stage === "all") return [...items];
  return items.filter((item) => productStage(item) === stage);
}
