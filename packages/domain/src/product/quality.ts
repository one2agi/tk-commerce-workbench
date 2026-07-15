// Pure collection-quality assessment. Three outcomes: "invalid" (cannot proceed),
// "partial" (can proceed but with warnings), "complete". Warning codes come from the
// frozen @tk/contracts catalog so UI/UX copy is stable.

import { strict as assert } from "node:assert";

import { CollectionWarningCodes } from "@tk/contracts";

export type CollectionQualityKind = "invalid" | "partial" | "complete";
export type CollectionWarningCode =
  (typeof CollectionWarningCodes)[keyof typeof CollectionWarningCodes];

export interface AssessCollectionQualityInput {
  sourceItemId: string;
  images: ReadonlyArray<{ url: string }>;
  title: string;
  sourcePrice: { amountMinor: string; currency: "CNY" } | null;
  skus: ReadonlyArray<{ skuId: string; attributes: Record<string, string> }>;
  weight: { value: string; unit: "kg" } | null;
  attributes: ReadonlyArray<{ name: string; value: string }>;
}

export interface CollectionQualityResult {
  kind: CollectionQualityKind;
  warnings: CollectionWarningCode[];
}

function hasUsableImages(images: ReadonlyArray<{ url: string }>): boolean {
  return images.some((img) => typeof img.url === "string" && img.url.length > 0);
}

export function assessCollectionQuality(
  input: AssessCollectionQualityInput
): CollectionQualityResult {
  assert(input, "input required");

  if (!input.sourceItemId || input.sourceItemId.length === 0) {
    return { kind: "invalid", warnings: [] };
  }
  if (!hasUsableImages(input.images)) {
    return { kind: "invalid", warnings: [] };
  }

  const warnings: CollectionWarningCode[] = [];
  if (!input.title || input.title.trim().length === 0) {
    warnings.push(CollectionWarningCodes.MissingTitle);
  }
  if (!input.sourcePrice || !input.sourcePrice.amountMinor || input.sourcePrice.amountMinor === "0") {
    warnings.push(CollectionWarningCodes.MissingSourcePrice);
  }
  if (!input.skus || input.skus.length === 0) {
    warnings.push(CollectionWarningCodes.MissingSku);
  }
  if (!input.weight || !input.weight.value || Number(input.weight.value) <= 0) {
    warnings.push(CollectionWarningCodes.MissingWeight);
  }
  if (!input.attributes || input.attributes.length === 0) {
    // Spec: missing subsets of attributes maps to missing_dimensions (the dim/attribute
    // gate that downstream size chart hint depends on).
    warnings.push(CollectionWarningCodes.MissingDimensions);
  }

  if (warnings.length === 0) {
    return { kind: "complete", warnings: [] };
  }
  return { kind: "partial", warnings };
}
