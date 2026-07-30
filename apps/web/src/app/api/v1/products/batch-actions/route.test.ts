import { describe, expect, it, vi } from "vitest";

import { createPostHandler } from "./route";

function request(body: unknown): Request {
  return new Request("http://127.0.0.1/api/v1/products/batch-actions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify(body)
  });
}

describe("batch product actions", () => {
  it("confirms only review-ready products using server-side preview snapshots", async () => {
    const confirmAndEnqueue = vi.fn().mockResolvedValue({ approvalSnapshotId: "approval-1", syncId: "sync-1" });
    const response = await createPostHandler({
      products: {
        preview: vi.fn().mockResolvedValue({
          productId: "product-1",
          draftVersion: 4,
          listingRunId: "listing-1",
          templateVersion: 3,
          orderedFinalAssetIds: ["asset-1"]
        })
      },
      approvals: { confirmAndEnqueue },
      reruns: { enqueueProductRetry: vi.fn() }
    })(request({ action: "confirm_miaoshou_edit", productIds: ["product-1"] }));

    expect(response.status).toBe(202);
    expect(confirmAndEnqueue).toHaveBeenCalledWith({
      version: 1,
      productId: "product-1",
      expectedDraftVersion: 4,
      expectedListingRunId: "listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-1"]
    });
  });

  it("marks products that are not ready for approval without confirming them", async () => {
    const confirmAndEnqueue = vi.fn();
    const response = await createPostHandler({
      products: { preview: vi.fn().mockResolvedValue(null) },
      approvals: { confirmAndEnqueue },
      reruns: { enqueueProductRetry: vi.fn() }
    })(request({ action: "confirm_miaoshou_edit", productIds: ["product-1"] }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      results: [{ productId: "product-1", ok: false, code: "approval_mapping_not_ready" }]
    });
    expect(confirmAndEnqueue).not.toHaveBeenCalled();
  });

  it("rejects empty product id arrays", async () => {
    const response = await createPostHandler({
      products: { preview: vi.fn() },
      approvals: { confirmAndEnqueue: vi.fn() },
      reruns: { enqueueProductRetry: vi.fn() }
    })(request({ action: "confirm_miaoshou_edit", productIds: [] }));

    expect(response.status).toBe(400);
  });

  it("routes batch retry through the product retry port", async () => {
    const enqueueProductRetry = vi.fn().mockResolvedValue(undefined);
    const response = await createPostHandler({
      products: { preview: vi.fn() },
      approvals: { confirmAndEnqueue: vi.fn() },
      reruns: { enqueueProductRetry }
    })(request({ action: "retry_from_failure", productIds: ["product-1"] }));

    expect(response.status).toBe(202);
    expect(enqueueProductRetry).toHaveBeenCalledWith("product-1");
  });
});
