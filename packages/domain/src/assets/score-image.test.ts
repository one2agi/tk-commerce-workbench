import { describe, expect, it } from "vitest";
import { scoreImage } from "./score-image.js";

describe("scoreImage", () => {
  it("persists all quality signals and chooses a product role", () => {
    const result = scoreImage({
      width: 1600,
      height: 1600,
      perceptualHash: "abcd",
      clarity: 0.9,
      duplicateDistance: 18,
      watermarkProbability: 0.05,
      collageProbability: 0.03,
      nonProductProbability: 0.02,
      visualScore: 0.88,
      sourceKind: "main"
    });
    expect(result).toMatchObject({ chosenRole: "primary", rejectionReason: null, width: 1600, height: 1600 });
    expect(result.score).toBeGreaterThan(0.8);
  });

  it.each([
    [{ width: 300, height: 300 }, "low_resolution"],
    [{ watermarkProbability: 0.9 }, "watermark"],
    [{ collageProbability: 0.9 }, "collage"],
    [{ nonProductProbability: 0.9 }, "non_product"],
    [{ duplicateDistance: 2 }, "duplicate"]
  ] as const)("rejects low quality signals", (override, reason) => {
    const result = scoreImage({
      width: 1200,
      height: 1200,
      perceptualHash: "abcd",
      clarity: 0.9,
      duplicateDistance: 20,
      watermarkProbability: 0.01,
      collageProbability: 0.01,
      nonProductProbability: 0.01,
      visualScore: 0.9,
      sourceKind: "detail",
      ...override
    });
    expect(result.rejectionReason).toBe(reason);
  });
});
