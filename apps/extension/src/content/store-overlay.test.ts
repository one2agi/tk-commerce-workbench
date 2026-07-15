// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSubmitSelectedMessage, sendSubmission } from "./store-overlay.js";

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

  it("surfaces a paused response and can retry the same idempotent batch", async () => {
    const responses = [{ outcome: "paused", reason: "api_unavailable" }, { outcome: "submitted", accepted: 1 }];
    const runtime = { sendMessage: (_message: unknown, callback: (response: unknown) => void) => callback(responses.shift()) };
    const message = createSubmitSelectedMessage("batch_abc", []);
    await expect(sendSubmission(runtime, message)).resolves.toMatchObject({ outcome: "paused" });
    await expect(sendSubmission(runtime, message)).resolves.toMatchObject({ outcome: "submitted" });
  });
});
