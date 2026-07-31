import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FinalImageOrder } from "./final-image-order";

describe("FinalImageOrder", () => {
  it("uses thumbnails for selected images and does not render selected Canvas assets twice", () => {
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
  });
});
