import { describe, expect, it } from "vitest";
import { matchTemplate } from "./match-template.js";

const templates = [
  { id: "default", enabled: true, rules: [] },
  { id: "fashion-low", enabled: true, rules: [{ category: "服装", priority: 10 }] },
  { id: "fashion-high", enabled: true, rules: [{ category: "服装", priority: 30 }] },
  { id: "disabled", enabled: false, rules: [{ category: "服装", priority: 99 }] }
];

describe("matchTemplate", () => {
  it("selects the highest-priority enabled category match", () => {
    expect(matchTemplate({ category: "服装", templates, defaultTemplateId: "default" })).toMatchObject({ id: "fashion-high", fallbackUsed: false });
  });

  it("uses the workspace default when no category rule matches", () => {
    expect(matchTemplate({ category: "鞋靴", templates, defaultTemplateId: "default" })).toMatchObject({ id: "default", fallbackUsed: true });
  });
});
