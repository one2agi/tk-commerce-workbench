import { describe, expect, it, vi } from "vitest";

import { createPostHandler } from "./route";

const context = { params: Promise.resolve({ productId: "prod-1" }) };

function request(host = "127.0.0.1", origin = "http://127.0.0.1") {
  return new Request(`http://${host}/api/v1/products/prod-1/retry-miaoshou-edit`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: "{}"
  });
}

describe("POST /api/v1/products/:productId/retry-miaoshou-edit", () => {
  it("queues an eligible manual retry and returns 202", async () => {
    const retryMiaoshouEditAfterNoChange = vi.fn().mockResolvedValue({
      approvalSnapshotId: "approval-1", syncId: "sync-1", jobId: "job-2"
    });

    const response = await createPostHandler({ approvals: { retryMiaoshouEditAfterNoChange } })(request(), context);

    expect(response.status).toBe(202);
    expect(retryMiaoshouEditAfterNoChange).toHaveBeenCalledWith("prod-1");
    expect(await response.json()).toEqual({
      approvalSnapshotId: "approval-1", syncId: "sync-1", jobId: "job-2"
    });
  });

  it.each(["retry_not_allowed", "revision_changed", "writeback_in_progress"])(
    "maps %s to a safe 409 response",
    async (code) => {
      const retryMiaoshouEditAfterNoChange = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
      const response = await createPostHandler({ approvals: { retryMiaoshouEditAfterNoChange } })(request(), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: code });
    }
  );

  it("rejects non-loopback or cross-origin mutations before calling the repository", async () => {
    const retryMiaoshouEditAfterNoChange = vi.fn();
    const handler = createPostHandler({ approvals: { retryMiaoshouEditAfterNoChange } });

    expect((await handler(request("example.com", "http://example.com"), context)).status).toBe(403);
    expect((await handler(request("127.0.0.1", "http://evil.test"), context)).status).toBe(403);
    expect(retryMiaoshouEditAfterNoChange).not.toHaveBeenCalled();
  });
});
