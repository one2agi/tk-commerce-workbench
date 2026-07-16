import type { ApprovalSnapshotV1 } from "@tk/contracts";

export type ApprovalSnapshotMaterial = Omit<ApprovalSnapshotV1, "sourcePlatform">;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createApprovalSnapshot(material: ApprovalSnapshotMaterial): ApprovalSnapshotV1 {
  const detached = structuredClone(material);
  return deepFreeze({ ...detached, sourcePlatform: "1688" as const });
}
