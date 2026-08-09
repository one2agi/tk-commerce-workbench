import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { templateId } from "@tk/contracts/ids";

import { renderTemplatesPage } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

describe("templates page", () => {
  it("renders persisted templates instead of the empty state", () => {
    const html = renderToStaticMarkup(renderTemplatesPage({
      items: [{
        templateId: templateId("tmpl_women_hat"),
        name: "女帽主图",
        categoryKey: "women.hat",
        parentCategoryKey: "women",
        version: 2,
        lifecycleState: "active",
        recipe: {
          inputCounts: { default: 2, min: 1, max: 6 },
          outputCounts: { default: 4, min: 1, max: 8 },
          mustPreserve: ["帽檐结构"],
          visualDirection: "干净的商品主图",
          forbidden: ["改变颜色"],
          roles: [{ key: "hero", instruction: "商品主体主图" }]
        },
        activatedAt: "2026-08-09T00:00:00.000Z",
        createdAt: "2026-08-08T00:00:00.000Z"
      }]
    }));

    expect(html).toContain("女帽主图");
    expect(html).not.toContain("暂无模板");
  });
});
