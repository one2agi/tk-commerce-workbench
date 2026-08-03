import { describe, expect, it } from "vitest";
import { imageSlotBusinessKey } from "./slot-business-key.js";
import { inferImageCategory } from "./infer-category.js";
import { resolveCategoryTemplate } from "./resolve-template.js";
import { validatePlannedPrompts } from "./validate-plan.js";
import { validateRecipe } from "./validate-recipe.js";

describe("headless image-generation rules", () => {
  it.each([[0, 1], [7, 1], [1, 0], [1, 9]])("rejects input=%i output=%i", (inputCount, outputCount) => {
    expect(() => validateRecipe({ inputCount, outputCount, roles: ["hero"] })).toThrow("image_generation_count_out_of_range");
  });
  it("requires exactly one contiguous prompt per requested slot", () => {
    expect(() => validatePlannedPrompts({ requestedCount: 2, mandatoryFacts: ["red bow"], prompts: [
      { slot: 1, role: "hero", prompt: "Show red bow", mustPreserve: ["red bow"], forbidden: [] },
      { slot: 1, role: "detail", prompt: "Detail red bow", mustPreserve: ["red bow"], forbidden: [] }
    ] })).toThrow("image_plan_slots_invalid");
  });
  it("falls back from child to the closest active parent", () => {
    expect(resolveCategoryTemplate("women.hat.sun", [
      { templateId: "generic", categoryKey: "generic", activeVersionId: "generic-v1" },
      { templateId: "hat", categoryKey: "women.hat", activeVersionId: "hat-v2" }
    ])?.templateId).toBe("hat");
  });
  it.each([
    ["蕾丝蝴蝶结大帽檐遮阳草帽", "women.hat"],
    ["复古珍珠耳环", "jewelry"],
    ["宽松棉麻衬衫", "apparel"],
    ["桌面收纳盒", "generic"]
  ])("infers %s as %s", (sourceTitle, expected) => {
    expect(inferImageCategory({ sourceTitle, sourceAttributes: [] })).toBe(expected);
  });

  it("uses structured attributes when the title alone is generic", () => {
    expect(inferImageCategory({
      sourceTitle: "夏季新品",
      sourceAttributes: [{ name: "品类", value: "草帽" }]
    })).toBe("women.hat");
  });
  it("creates a deterministic paid-call key", () => {
    expect(imageSlotBusinessKey({ revisionId: "rev_1", templateVersionId: "tv_2", slot: 3, promptHash: "abc" }))
      .toBe("rev_1:tv_2:3:abc");
  });
});
