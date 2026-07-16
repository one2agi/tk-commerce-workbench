import type { PoolClient } from "pg";
import type { ApprovalRepository } from "@tk/db";

export interface ApprovalInvalidationPort {
  invalidateInTransaction(client: PoolClient, productId: string, reason: string): Promise<boolean>;
}

type ApprovalInvalidationRepository = Pick<ApprovalRepository, "invalidateForProductInTransaction">;

export function createApprovalInvalidationPort(
  repository: ApprovalInvalidationRepository
): ApprovalInvalidationPort {
  return {
    invalidateInTransaction: (client, productId, reason) =>
      repository.invalidateForProductInTransaction(client, productId, reason)
  };
}
