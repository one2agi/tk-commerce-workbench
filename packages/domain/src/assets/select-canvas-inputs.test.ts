import { describe, expect, it } from "vitest";
import { selectCanvasInputs } from "./select-canvas-inputs.js";

describe("selectCanvasInputs", () => {
  const candidates = [
    { assetId: "main-1", url: "https://cdn/main.jpg", role: "primary" as const, score: 0.95, perceptualHash: "a" },
    { assetId: "angle-1", url: "https://cdn/angle.jpg", role: "angle" as const, score: 0.9, perceptualHash: "b" },
    { assetId: "duplicate", url: "https://cdn/dup.jpg", role: "angle" as const, score: 0.89, perceptualHash: "a" },
    { assetId: "detail-1", url: "https://cdn/detail.jpg", role: "detail" as const, score: 0.8, perceptualHash: "c" },
    { assetId: "sku-1", url: "https://cdn/sku.jpg", role: "sku" as const, score: 0.75, perceptualHash: "d" }
  ];

  it("selects distinct product images by role without filling unused slots with duplicates", () => {
    const selected = selectCanvasInputs({ candidates, referenceUrls: ["https://cdn/ref.jpg"], capacity: 9 });
    expect(selected.productImages.map((x) => x.assetId)).toEqual(["main-1", "angle-1", "detail-1", "sku-1"]);
    expect(selected.referenceUrls).toEqual(["https://cdn/ref.jpg"]);
    expect(selected.totalCount).toBe(5);
  });

  it("obeys live capacity and requires at least one product image", () => {
    expect(selectCanvasInputs({ candidates, referenceUrls: ["r1", "r2"], capacity: 2 }).totalCount).toBe(2);
    expect(() => selectCanvasInputs({ candidates: [], referenceUrls: ["r1"], capacity: 9 })).toThrow(/product image/i);
  });
});
