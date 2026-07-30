// ExternalFailure: every error that escapes an adapter port must be classified here.
// `safeMessage` is the only string carried into logs/UI — adapters must redact
// headers, signatures, raw bodies, AppSecrets and API keys before throwing.

export type ExternalFailureKind =
  | "retryable"
  | "needs_input"
  | "reconcile_required"
  | "fatal";

export type ExternalFailure = Readonly<{
  kind: ExternalFailureKind;
  code: string;
  safeMessage: string;
}>;

export function externalFailure(
  kind: ExternalFailureKind,
  code: string,
  safeMessage: string
): ExternalFailure {
  return Object.freeze({ kind, code, safeMessage });
}

export function isExternalFailure(value: unknown): value is ExternalFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    ["retryable", "needs_input", "reconcile_required", "fatal"].includes(String(candidate.kind))
    && typeof candidate.code === "string"
    && candidate.code.length > 0
    && typeof candidate.safeMessage === "string"
    && candidate.safeMessage.length > 0
  );
}

export function isReconcileRequired(failure: ExternalFailure): boolean {
  return failure.kind === "reconcile_required";
}

// Hard mapping required by Spec: reconcile_required failures must persist the
// external write state as `result_unknown`. Only successful reconciliation or
// an explicit terminal failure leaves that state. Expired-lease recovery
// cannot requeue the external write while it is still unknown.
export function reconcileRequiredFailure(code: string, safeMessage: string): ExternalFailure {
  return externalFailure("reconcile_required", code, safeMessage);
}

// Stable warning codes for collection quality. New codes are version-bumped; existing codes
// are part of the public contract (UI renders them).
export const CollectionWarningCodes = {
  MissingTitle: "missing_title",
  MissingSourcePrice: "missing_source_price",
  MissingSku: "missing_sku",
  MissingWeight: "missing_weight",
  MissingDimensions: "missing_dimensions",
  MissingSizeChart: "missing_size_chart",
  MissingVideo: "missing_video",
  MissingCertification: "missing_certification"
} as const;

export type CollectionWarningCode = (typeof CollectionWarningCodes)[keyof typeof CollectionWarningCodes];
