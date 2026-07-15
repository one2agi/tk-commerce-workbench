import { describe, expect, it } from "vitest";
import { ConfirmMiaoshouEditV1, IngestLinksV1, StartAutomationV1 } from "./commands.js";

describe("command contracts", () => {
  it("accepts selected 1688 links only", () => {
    const result = IngestLinksV1.safeParse({
      version: 1,
      batchId: "batch_01",
      items: [
        {
          sourceUrl: "https://detail.1688.com/offer/892408514788.html",
          idempotencyKey: "1688:892408514788:batch_01"
        }
      ]
    });
    expect(result.success).toBe(true);
  });

  it("requires explicit commands for processing and Miaoshou edit", () => {
    const start = StartAutomationV1.parse({ version: 1, revisionIds: ["rev_01"] });
    expect(start.revisionIds).toHaveLength(1);

    const confirm = ConfirmMiaoshouEditV1.parse({
      version: 1,
      productId: "product_01",
      expectedDraftVersion: 3,
      expectedListingRunId: "listing_run_01",
      expectedPricingRunId: "pricing_run_01",
      expectedTemplateVersion: 2,
      orderedFinalAssetIds: ["asset_01", "asset_02"]
    });
    expect(confirm.expectedDraftVersion).toBe(3);
    expect(confirm.orderedFinalAssetIds).toHaveLength(2);
  });
});
