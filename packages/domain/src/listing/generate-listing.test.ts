import { describe, expect, it } from "vitest";
import { createFakePorts } from "@tk/contracts/testing";
import { generateListing } from "./generate-listing.js";

const input = {
  sourceLocale: "zh-CN",
  targetLocale: "th-TH",
  style: "简洁",
  evidence: {
    sourceTitle: "批发 批发 女士纯棉 T恤 联系微信 wx123",
    sourceDescription: "女士 T恤\u200b",
    sourceAttributes: [{ name: "材质", value: "棉" }]
  },
  idempotencyKey: "listing-rev-1"
} as const;

describe("generateListing", () => {
  it("sanitizes model output while retaining evidence-backed attributes", async () => {
    const ports = createFakePorts();
    ports.llm.output = {
      title: "新品 新品 女士纯棉 T恤 联系电话 12345678901",
      description: "舒适女士 T恤\u200b",
      translatedAttributes: [{ name: "材质", value: "棉" }],
      styleApplied: "简洁",
      fallbackUsed: false
    };

    const result = await generateListing({ port: ports.llm, input });

    expect(result.title).toBe("新品 女士纯棉 T恤");
    expect(result.description).not.toContain("\u200b");
    expect(result.attributes).toEqual([{ name: "材质", value: "棉" }]);
    expect(result).toMatchObject({ provider: "llm", degraded: false, fallbackUsed: false });
  });

  it("falls back to deterministic rules and marks the result degraded on LLM failure", async () => {
    const ports = createFakePorts();
    ports.llm.generateListing = async () => {
      throw new Error("provider unavailable");
    };

    const result = await generateListing({ port: ports.llm, input });

    expect(result.title).toBe("女士纯棉 T恤");
    expect(result).toMatchObject({ provider: "rules", degraded: true, fallbackUsed: true });
    expect(result.warningCodes).toContain("llm_rule_fallback");
  });
});
