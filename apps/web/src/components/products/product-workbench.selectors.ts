// Stage overview projection + filter logic. Pure functions over the
// ProductPoolItemV1 read model so they can be exercised without a DOM.
//
// Stage counts come from per-aggregate state projections — NEVER from a
// single global status field. The user must never be allowed to mutate status
// by clicking a stage card: applyStageFilter only narrows the displayed list.

import type {
  AssetArchiveState,
  AutomationState,
  CanvasState,
  ListingState,
  MiaoshouEditState,
  MiaoshouSourceState
} from "@tk/contracts/states";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

export type ProductPoolItem = ProductPoolItemV1;

export type StageKey =
  | "all"
  | "collection"
  | "listing"
  | "miaoshouEdit";

export type StageCard = Readonly<{
  key: StageKey;
  label: string;
  count: number;
}>;

export type StageOverview = Readonly<{
  all: StageCard;
  collection: StageCard;
  listing: StageCard;
  miaoshouEdit: StageCard;
}>;

const COLLECTION_TERMINAL: ReadonlySet<MiaoshouSourceState> = new Set([
  "success",
  "skipped_duplicate"
]);
const LISTING_TERMINAL: ReadonlySet<ListingState> = new Set(["ready"]);
const MIAOSHOU_EDIT_TERMINAL: ReadonlySet<MiaoshouEditState> = new Set([
  "succeeded"
]);

function labelFor(stage: StageKey, count: number): string {
  switch (stage) {
    case "all":
      return `全部阶段（${count}）`;
    case "collection":
      return `收集阶段（${count}）`;
    case "listing":
      return `listing 阶段（${count}）`;
    case "miaoshouEdit":
      return `妙手回写阶段（${count}）`;
  }
}

export function buildStageOverview(items: ReadonlyArray<ProductPoolItem>): StageOverview {
  const collection = items.filter((i) => !COLLECTION_TERMINAL.has(i.miaoshouSource)).length;
  const listing = items.filter((i) => !LISTING_TERMINAL.has(i.listing)).length;
  const miaoshou = items.filter((i) => !MIAOSHOU_EDIT_TERMINAL.has(i.miaoshouEdit)).length;
  const all = items.length;
  return {
    all: { key: "all", label: labelFor("all", all), count: all },
    collection: { key: "collection", label: labelFor("collection", collection), count: collection },
    listing: { key: "listing", label: labelFor("listing", listing), count: listing },
    miaoshouEdit: { key: "miaoshouEdit", label: labelFor("miaoshouEdit", miaoshou), count: miaoshou }
  };
}

export function applyStageFilter(
  items: ReadonlyArray<ProductPoolItem>,
  stage: StageKey
): ProductPoolItem[] {
  switch (stage) {
    case "all":
      return [...items];
    case "collection":
      return items.filter((i) => !COLLECTION_TERMINAL.has(i.miaoshouSource));
    case "listing":
      return items.filter((i) => !LISTING_TERMINAL.has(i.listing));
    case "miaoshouEdit":
      return items.filter((i) => !MIAOSHOU_EDIT_TERMINAL.has(i.miaoshouEdit));
  }
}

// Re-exported here so the state module can type its reducers without dragging
// the contracts package into every component file.
export type {
  AssetArchiveState,
  AutomationState,
  CanvasState,
  ListingState,
  MiaoshouEditState,
  MiaoshouSourceState
};