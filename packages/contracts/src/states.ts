// Per-aggregate state machines. UI may compose these into a friendly "stage" but business
// logic must never depend on a single global status.

export type CollectionState =
  | "queued"
  | "submitting"
  | "resolving_duplicate"
  | "importing"
  | "partial"
  | "complete"
  | "failed";

export type MiaoshouSourceState =
  | "not_started"
  | "submitted"
  | "pending"
  | "success"
  | "skipped_duplicate"
  | "failed";

export type AutomationState =
  | "not_started"
  | "queued"
  | "running"
  | "paused"
  | "needs_input"
  | "ready"
  | "failed"
  | "cancelled";

export type AssetArchiveState = "pending" | "downloading" | "ready" | "partial" | "failed";

export type ListingState = "pending" | "generating" | "needs_input" | "ready" | "failed";

export type CanvasState =
  | "not_started"
  | "queued"
  | "running"
  | "partial"
  | "succeeded"
  | "failed";

export type ApprovalState = "unapproved" | "approved" | "invalidated";

export type MiaoshouEditState =
  | "not_started"
  | "queued"
  | "syncing"
  | "result_unknown"
  | "succeeded"
  | "failed";

export type ExchangeRateState = "fresh" | "stale" | "manual_override" | "needs_input";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "needs_input"
  | "ready"
  | "failed"
  | "succeeded";
