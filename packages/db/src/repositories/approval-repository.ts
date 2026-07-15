// Approval repository.
//
// Contract surface freeze (Plan Task 4 / Wave 1 Core brief):
//   `confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<{ approvalSnapshotId; syncId }>`
//
// Task 12 fills the complete mapping from ConfirmMiaoshouEditV1 to
// ApprovalSnapshotV1. Until then the method keeps the frozen compile-time signature
// but fails closed before any write, instead of creating a misleading approval with
// empty source/listing/pricing fields.

import { strict as assert } from "node:assert";

import type { ConfirmMiaoshouEditV1 } from "@tk/contracts";

import { schema, type DbPool } from "../schema/index.js";

export interface ConfirmResult {
  approvalSnapshotId: string;
  syncId: string;
}

/**
 * Wave 1 deliberately cannot construct the immutable, complete approval snapshot yet.
 * Callers may surface this as "待补全"; they must never treat it as an approval.
 */
export class ApprovalNotReadyError extends Error {
  readonly code = "approval_mapping_not_ready";

  constructor() {
    super("Approval mapping is not complete; no snapshot or Miaoshou job was created");
    this.name = "ApprovalNotReadyError";
  }
}

export class ApprovalRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async confirmAndEnqueue(command: ConfirmMiaoshouEditV1): Promise<ConfirmResult> {
    assert(command.version === 1, "ConfirmMiaoshouEditV1 version must be 1");
    assert(command.productId.length > 0, "productId required");
    assert(command.orderedFinalAssetIds.length > 0, "orderedFinalAssetIds required");

    // The command currently has no revisionId and the Wave 1 schema/repositories do not
    // yet provide the complete source/listing/pricing/SKU mapping. Writing guessed or
    // empty values would create an apparently approved, billable external edit. Fail
    // before opening a transaction, so the boundary is provably write-free.
    void this.pool;
    throw new ApprovalNotReadyError();
  }
}
