import type { PoolClient } from "pg";
import { ApprovalRepository, type DbPool } from "@tk/db";

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

export function createPgApprovalInvalidationPort(pool: () => DbPool): ApprovalInvalidationPort {
  return {
    invalidateInTransaction: (client, productId, reason) =>
      new ApprovalRepository(pool()).invalidateForProductInTransaction(client, productId, reason)
  };
}
