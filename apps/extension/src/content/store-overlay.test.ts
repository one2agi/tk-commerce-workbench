// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSubmitSelectedMessage } from "./store-overlay.js";

describe("store overlay message", () => {
  it("includes a non-empty batch id with only the selected items", () => {
    const selected = [{
      sourceItemId: "892408514788",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      title: "工装短裤"
    }];

    expect(createSubmitSelectedMessage("batch_abc", selected)).toEqual({
      kind: "submit-selected",
      batchId: "batch_abc",
      items: selected
    });
  });
});
