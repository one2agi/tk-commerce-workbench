// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSubmitSelectedHandler } from "./index.js";

describe("background message bridge", () => {
  it("passes the content-script batch id and selected items to the submitter", async () => {
    const submitBatch = vi.fn(async () => ({ outcome: "submitted" as const, accepted: 1, items: [] }));
    const sendResponse = vi.fn();
    const handler = createSubmitSelectedHandler({ submitBatch });
    const message = {
      kind: "submit-selected",
      batchId: "batch_abc",
      items: [{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html"
      }]
    };

    expect(handler(message, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(submitBatch).toHaveBeenCalledWith({ batchId: "batch_abc", items: message.items });
  });
});
