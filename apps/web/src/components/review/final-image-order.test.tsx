import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FinalImageOrder, buildFinalImageCandidates } from "./final-image-order";

describe("FinalImageOrder", () => {
  it("uses thumbnails for selected images and does not render selected processed assets twice", () => {
    const html = renderToStaticMarkup(<FinalImageOrder
      orderedFinalImages={[{
        assetId: "asset_1",
        previewUrl: "/api/v1/assets/asset_1/content",
        thumbnailUrl: "/api/v1/assets/asset_1/content?variant=thumbnail"
      }]}
      outputs={["asset_1", "asset_2"]}
    />);

    expect(html).toContain("src=\"/api/v1/assets/asset_1/content?variant=thumbnail\"");
    expect(html.match(/asset_1\/content/g)).toHaveLength(1);
    expect(html).toContain("src=\"/api/v1/assets/asset_2/content?variant=thumbnail\"");
    expect(html).toContain("待确认成图 1");
    expect(html).not.toContain("Canvas");
  });

  it("orders accepted successful generated assets without source-image mixing", () => {
    const workspaceWithAcceptedSlots = () => ({
      reviewFacts: {
        skuCount: null,
        stock: null,
        weightKg: null,
        dimensions: null,
        canonicalMiaoshouTarget: null,
        orderedFinalImages: [
          { assetId: "generated_hero", previewUrl: "/api/v1/assets/generated_hero/content", thumbnailUrl: "/api/v1/assets/generated_hero/content?variant=thumbnail" },
          { assetId: "generated_detail", previewUrl: "/api/v1/assets/generated_detail/content", thumbnailUrl: "/api/v1/assets/generated_detail/content?variant=thumbnail" }
        ]
      },
      originalListing: {
        sourceTitle: "Source product",
        description: "",
        sourceAttributes: [],
        saleAttributes: [],
        mainImages: ["https://source.1688.com/hero.jpg"],
        detailImages: []
      }
    });

    const candidates = buildFinalImageCandidates(workspaceWithAcceptedSlots());

    expect(candidates).toEqual([
      expect.objectContaining({ assetId: "generated_hero", kind: "processed" }),
      expect.objectContaining({ assetId: "generated_detail", kind: "processed" })
    ]);
    // Source images must not appear in candidates
    expect(candidates.some((c: { assetId: string; kind: string }) => c.kind === "source")).toBe(false);
  });
});
