import { describe, expect, it } from "vitest";

import {
  parseFrozenImageGenerationRecipeV1,
  parseImageGenerateSlotJobPayload,
} from "./image-generation.js";

describe("headless image-generation contracts", () => {
  it("preserves the complete frozen category recipe consumed by planning and generation", () => {
    const recipe = parseFrozenImageGenerationRecipeV1({
      version: 1,
      inputCount: 2,
      outputCount: 2,
      mustPreserve: ["蕾丝蝴蝶结", "米白色"],
      visualDirection: "海边度假场景，商品为画面主体",
      forbidden: ["改变帽檐结构", "添加品牌标识"],
      roles: [
        { key: "hero", instruction: "正面主图，完整展示帽檐" },
        { key: "scene", instruction: "自然海边使用场景" }
      ],
      providerParameters: {
        model: "agnes-image",
        size: "2048x2048",
        quality: "high"
      }
    });

    expect(recipe).toEqual({
      version: 1,
      inputCount: 2,
      outputCount: 2,
      mustPreserve: ["蕾丝蝴蝶结", "米白色"],
      visualDirection: "海边度假场景，商品为画面主体",
      forbidden: ["改变帽檐结构", "添加品牌标识"],
      roles: [
        { key: "hero", instruction: "正面主图，完整展示帽檐" },
        { key: "scene", instruction: "自然海边使用场景" }
      ],
      providerParameters: {
        model: "agnes-image",
        size: "2048x2048",
        quality: "high"
      }
    });
  });

  it("accepts a one-based version-1 slot payload with a separate attempt", () => {
    expect(parseImageGenerateSlotJobPayload({
      version: 1,
      batchId: "batch_1",
      slotId: "slot_1",
      slotNumber: 1,
      attempt: 0
    })).toEqual({
      version: 1,
      batchId: "batch_1",
      slotId: "slot_1",
      slotNumber: 1,
      attempt: 0
    });
  });

  it.each([
    [{ version: 1, batchId: "batch_1", slotId: "slot_1", slotNumber: 0, attempt: 1 }, "slotNumber"],
    [{ version: 1, batchId: "batch_1", slotId: "slot_1", slotNumber: 9, attempt: 1 }, "slotNumber"],
    [{ version: 2, batchId: "batch_1", slotId: "slot_1", slotNumber: 1, attempt: 1 }, "version"],
    [{ version: 1, batchId: "batch_1", slotId: "slot_1", slotNumber: 1, attempt: -1 }, "attempt"]
  ])("rejects an invalid slot job payload %#", (payload, field) => {
    expect(() => parseImageGenerateSlotJobPayload(payload)).toThrow(field);
  });
});
