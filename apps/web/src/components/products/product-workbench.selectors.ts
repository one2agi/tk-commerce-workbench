import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import {
  canStartProcessing,
  productBusinessStage,
  STAGE_LABELS,
  STAGE_ORDER,
  type ProductBusinessStage,
  type WorkbenchStageKey
} from "./product-row-view";

export type ProductPoolItem = ProductPoolItemV1;
export type StageKey = WorkbenchStageKey;
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

export { STAGE_ORDER };

export function productStage(item: ProductPoolItem): ProductBusinessStage {
  return productBusinessStage(item);
}

export function canStartAutomation(item: ProductPoolItem): boolean {
  return canStartProcessing(item);
}

export function buildAutomationProgress(item: ProductPoolItem): AutomationProgressNode[] {
  const collect: AutomationProgressNode["state"] = item.miaoshouSource === "local_captured" || item.miaoshouSource === "success" || item.miaoshouSource === "skipped_duplicate"
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
    { key: "listing", label: "上架草稿", state: listing },
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
      { key, label: `${STAGE_LABELS[key]}（${counts[key]}）`, count: counts[key] }
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
