import { describe, expect, it } from "vitest";
import { assetId, productId, productRevisionId } from "@tk/contracts/ids";
import type { ReviewWorkspaceView } from "../review/review-workspace-view";
import { buildCollectedImages, buildProcessedImages } from "./product-image-workbench";

function workspace(): ReviewWorkspaceView {
  return {
    productId: productId("prod-1"),
    revisionId: productRevisionId("rev-1"),
    draftVersion: 1,
    originalListing: {
      sourceTitle: "商品",
      description: "",
      sourceAttributes: [],
      saleAttributes: [],
      mainImages: ["https://source.test/main.jpg"],
      detailImages: ["https://source.test/detail.jpg"]
    },
    target: null,
    pricing: null,
    template: null,
    canvas: {
      runId: "legacy-1",
      state: "succeeded",
      outputs: ["/api/v1/assets/generated-1/content", "asset_legacy"]
    },
    imageGeneration: {
      batchId: "batch-1",
      availableInputs: [
        {
          assetId: assetId("source-1"),
          localUrl: "/api/v1/assets/source-1/content",
          role: "main",
          sourceUrl: "https://source.test/main.jpg"
        },
        {
          assetId: assetId("source-3"),
          localUrl: "/api/v1/assets/source-3/content",
          role: "detail",
          sourceUrl: null
        }
      ],
      selectedInputs: [],
      inferredCategory: "hat",
      confirmedCategory: null,
      requestedCount: 1,
      successfulCount: 1,
      state: "succeeded",
      slots: [{
        slotId: "slot-1",
        slotNumber: 1,
        role: "main",
        status: "succeeded",
        attempt: 1,
        localUrl: "/api/v1/assets/generated-1/content",
        acceptedOrder: null,
        error: null
      }],
      warnings: []
    },
    finalAssetOrder: [],
    warningCodes: [],
    reviewFacts: {
      skuCount: null,
      orderedFinalImages: [],
      stock: null,
      weightKg: null,
      dimensions: null,
      canonicalMiaoshouTarget: null
    }
  };
}

describe("product image workbench projections", () => {
  it("substitutes local archives in source order and keeps unarchived evidence visible", () => {
    expect(buildCollectedImages(workspace())).toEqual([
      expect.objectContaining({
        url: "/api/v1/assets/source-1/content",
        assetId: "source-1",
        selectable: true
      }),
      expect.objectContaining({
        url: "https://source.test/detail.jpg",
        assetId: null,
        selectable: false
      }),
      expect.objectContaining({
        url: "/api/v1/assets/source-3/content",
        assetId: "source-3",
        selectable: true
      })
    ]);
  });

  it("shows headless outputs before legacy results and removes duplicate URLs", () => {
    expect(buildProcessedImages(workspace()).map((image) => image.url)).toEqual([
      "/api/v1/assets/generated-1/content",
      "/api/v1/assets/asset_legacy/content"
    ]);
  });
});
