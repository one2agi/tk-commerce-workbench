import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import {
  projectUiStage,
  type UiStageLabel
} from "@tk/domain/state/project-ui-stage";

export type ProductPoolItem = ProductPoolItemV1;
export type StageKey = "all" | UiStageLabel;

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
    hasUsableCanvasOutputs: item.imageCount > 0
  }).label;
}

export function canStartAutomation(item: ProductPoolItem): boolean {
  return item.automation === "not_started";
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
