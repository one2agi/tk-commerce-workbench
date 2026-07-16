import { describe, expect, it, vi } from "vitest";

import { createApprovalInvalidationPort } from "./approval-invalidation";

function transaction(input: { syncState: string | null; jobStatuses: string[] }) {
  const query = vi.fn(async (sql: string) => {
    if (/SELECT id FROM products/.test(sql)) return { rows: [{ id: "product-1" }], rowCount: 1 };
    if (/SELECT id FROM approval_snapshots/.test(sql)) return { rows: [{ id: "approval-1" }], rowCount: 1 };
    if (/SELECT state FROM miaoshou_syncs/.test(sql)) {
      return { rows: input.syncState ? [{ state: input.syncState }] : [], rowCount: input.syncState ? 1 : 0 };
    }
    if (/SELECT status FROM jobs/.test(sql)) {
      return { rows: input.jobStatuses.map((status) => ({ status })), rowCount: input.jobStatuses.length };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query };
}

describe("ApprovalInvalidationPort", () => {
  it.each([
    { syncState: "queued", jobStatuses: ["running"] },
    { syncState: "syncing", jobStatuses: ["queued"] },
    { syncState: "result_unknown", jobStatuses: ["paused"] }
  ])("fails closed for active or uncertain Miaoshou sync state %#", async (input) => {
    const client = transaction(input);
    await expect(createApprovalInvalidationPort().invalidateInTransaction(
      client as never, "product-1", "draft_changed"
    )).rejects.toMatchObject({ code: "approval_sync_in_progress" });
    expect(client.query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(/UPDATE approval_snapshots/);
  });

  it("locks product, approval, sync and job in order, then atomically cancels queued work", async () => {
    const client = transaction({ syncState: "queued", jobStatuses: ["queued", "paused"] });
    await expect(createApprovalInvalidationPort().invalidateInTransaction(
      client as never, "product-1", "rerun_requested"
    )).resolves.toBe(true);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    const at = (pattern: RegExp) => statements.findIndex((sql) => pattern.test(sql));
    expect(at(/SELECT id FROM products[\s\S]*FOR UPDATE/)).toBeLessThan(at(/SELECT id FROM approval_snapshots/));
    expect(at(/SELECT id FROM approval_snapshots[\s\S]*FOR UPDATE/)).toBeLessThan(at(/SELECT state FROM miaoshou_syncs/));
    expect(at(/SELECT state FROM miaoshou_syncs[\s\S]*FOR UPDATE/)).toBeLessThan(at(/SELECT status FROM jobs/));
    expect(at(/UPDATE approval_snapshots/)).toBeLessThan(at(/UPDATE jobs/));
    expect(statements.join("\n")).toMatch(/status IN \('queued', 'paused'\)/);
    expect(statements.join("\n")).toMatch(/state = 'queued'/);
  });
});
