import type { ApprovalSnapshotV1 } from "@tk/contracts";

function approvalMaterial(snapshot: ApprovalSnapshotV1): unknown {
  const { approvalSnapshotId: _approvalSnapshotId, createdAt: _createdAt, ...material } = snapshot;
  return material;
}

export function invalidatesApproval(
  approved: ApprovalSnapshotV1,
  current: ApprovalSnapshotV1
): boolean {
  return JSON.stringify(approvalMaterial(approved)) !== JSON.stringify(approvalMaterial(current));
}
