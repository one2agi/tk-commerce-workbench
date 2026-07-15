// RED-first test for collection quality assessment.

import { describe, expect, test } from "vitest";

import { CollectionWarningCodes } from "@tk/contracts";

import { assessCollectionQuality } from "./quality.js";

const COMPLETE_INPUT = {
  sourceItemId: "src-1",
  images: [{ url: "https://example.com/a.jpg" }, { url: "https://example.com/b.jpg" }],
  title: "Wool sweater",
  sourcePrice: { amountMinor: "1280", currency: "CNY" as const },
  skus: [{ skuId: "sku-1", attributes: { color: "red" } }],
  weight: { value: "0.40", unit: "kg" as const },
  attributes: [{ name: "material", value: "wool" }]
};

describe("assessCollectionQuality", () => {
  test("returns complete when every required input is present", () => {
    const result = assessCollectionQuality(COMPLETE_INPUT);
    expect(result.kind).toBe("complete");
    expect(result.warnings).toEqual([]);
  });

  test("returns invalid when source item id is missing", () => {
    const result = assessCollectionQuality({ ...COMPLETE_INPUT, sourceItemId: "" });
    expect(result.kind).toBe("invalid");
  });

  test("returns invalid when zero usable product images", () => {
    const result = assessCollectionQuality({ ...COMPLETE_INPUT, images: [] });
    expect(result.kind).toBe("invalid");
  });

  test("returns partial with stable warning codes when single fields are missing", () => {
    const cases: Array<{
      patch: Parameters<typeof assessCollectionQuality>[0];
      code: typeof CollectionWarningCodes[keyof typeof CollectionWarningCodes];
    }> = [
      { patch: { ...COMPLETE_INPUT, title: "" }, code: CollectionWarningCodes.MissingTitle },
      {
        patch: { ...COMPLETE_INPUT, sourcePrice: null },
        code: CollectionWarningCodes.MissingSourcePrice
      },
      {
        patch: { ...COMPLETE_INPUT, skus: [] },
        code: CollectionWarningCodes.MissingSku
      },
      {
        patch: { ...COMPLETE_INPUT, weight: null },
        code: CollectionWarningCodes.MissingWeight
      },
      {
        patch: { ...COMPLETE_INPUT, attributes: [] },
        code: CollectionWarningCodes.MissingDimensions
      }
    ];
    for (const c of cases) {
      const result = assessCollectionQuality(c.patch);
      expect(result.kind).toBe("partial");
      expect(result.warnings).toContain(c.code);
    }
  });

  test("accumulates multiple missing-field warnings", () => {
    const result = assessCollectionQuality({
      ...COMPLETE_INPUT,
      title: "",
      weight: null,
      skus: []
    });
    expect(result.kind).toBe("partial");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        CollectionWarningCodes.MissingTitle,
        CollectionWarningCodes.MissingWeight,
        CollectionWarningCodes.MissingSku
      ])
    );
  });
});
