import { describe, expect, it, vi } from "vitest";
import type { ImageGenerationTemplateService } from "../../../../../server/services/image-generation-template-service";
import { createPatchHandler } from "./route";

const recipe = {
  inputCounts: { default: 2, min: 1, max: 6 },
  outputCounts: { default: 4, min: 1, max: 8 },
  mustPreserve: ["商品结构"],
  visualDirection: "海边度假场景",
  forbidden: ["改变商品颜色"],
  roles: [{ key: "hero", instruction: "商品主体主图" }]
};

describe("PATCH /image-generation-templates/[templateId]", () => {
  it("appends a validated draft version", async () => {
    const updateDraft = vi.fn().mockResolvedValue({ templateId: "tpl_1", version: 3, lifecycleState: "draft" });
    const handler = createPatchHandler({ service: { updateDraft } as unknown as ImageGenerationTemplateService });
    const response = await handler(new Request("http://127.0.0.1/api/v1/image-generation-templates/tpl_1", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, recipe })
    }), { params: Promise.resolve({ templateId: "tpl_1" }) });

    expect(response.status).toBe(201);
    expect(updateDraft).toHaveBeenCalledWith({ templateId: "tpl_1", expectedVersion: 2, recipeOverride: recipe });
  });

  it("rejects an invalid recipe before calling the service", async () => {
    const updateDraft = vi.fn();
    const handler = createPatchHandler({ service: { updateDraft } as unknown as ImageGenerationTemplateService });
    const response = await handler(new Request("http://127.0.0.1/api/v1/image-generation-templates/tpl_1", {
      method: "PATCH",
      headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2, recipe: { ...recipe, outputCounts: { min: 1, default: 4, max: 9 } } })
    }), { params: Promise.resolve({ templateId: "tpl_1" }) });

    expect(response.status).toBe(400);
    expect(updateDraft).not.toHaveBeenCalled();
  });
});
