import { describe, expect, it, vi } from "vitest";

import { createApprovalInvalidationPort } from "./approval-invalidation";

describe("ApprovalInvalidationPort", () => {
  it("delegates the transaction to the single Core approval state machine", async () => {
    const client = { query: vi.fn() };
    const invalidateForProductInTransaction = vi.fn(async () => true);

    await expect(createApprovalInvalidationPort({ invalidateForProductInTransaction }).invalidateInTransaction(
      client as never, "product-1", "rerun_requested"
    )).resolves.toBe(true);

    expect(invalidateForProductInTransaction).toHaveBeenCalledOnce();
    expect(invalidateForProductInTransaction).toHaveBeenCalledWith(
      client, "product-1", "rerun_requested"
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("preserves Core conflict errors without translating or swallowing them", async () => {
    const conflict = Object.assign(new Error("sync active"), {
      code: "approval_sync_in_progress",
      metadata: { approvalSnapshotId: "approval-1", syncState: "result_unknown", jobStatus: "paused" }
    });
    const invalidateForProductInTransaction = vi.fn(async () => { throw conflict; });

    await expect(createApprovalInvalidationPort({ invalidateForProductInTransaction }).invalidateInTransaction(
      { query: vi.fn() } as never, "product-1", "draft_changed"
    )).rejects.toBe(conflict);
  });
});
