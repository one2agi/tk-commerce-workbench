// Immutable revision + working draft version.
//
// A "revision" is a frozen snapshot of the input collection for a product. Once written,
// its fields never change — each new round of automation produces a new revision row.
// The "working draft" is the in-progress draft associated with that revision; it bumps
// monotonically inside the lifetime of one revision. This module is pure: the actual
// persistence lives in db repositories.

import { strict as assert } from "node:assert";

export interface RevisionSnapshot {
  readonly productId: string;
  readonly revisionId: string;
  readonly draftVersion: number;
  readonly sourceTitle: string;
  readonly sourcePayload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface WorkingDraftBumpInput {
  readonly previous: RevisionSnapshot;
  readonly nextDraftVersion: number;
}

export function bumpDraftVersion(
  input: WorkingDraftBumpInput
): { readonly revisionId: string; readonly draftVersion: number } {
  assert(input.nextDraftVersion > input.previous.draftVersion, "draft version must increase");
  assert(
    input.previous.productId.length > 0,
    "revision must belong to a product"
  );
  return {
    revisionId: input.previous.revisionId,
    draftVersion: input.nextDraftVersion
  };
}

export function createRevision(input: {
  productId: string;
  sourceTitle: string;
  sourcePayload: Readonly<Record<string, unknown>>;
  initialDraftVersion?: number;
}): RevisionSnapshot {
  assert(input.productId.length > 0, "productId required");
  const revisionId = `rev_${input.productId}_${Date.now().toString(36)}`;
  return {
    productId: input.productId,
    revisionId,
    draftVersion: input.initialDraftVersion ?? 1,
    sourceTitle: input.sourceTitle,
    sourcePayload: input.sourcePayload,
    createdAt: new Date().toISOString()
  };
}
