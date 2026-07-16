type SafeConflictValue = string | number | boolean | null | SafeConflictValue[];

const SAFE_FIELDS = new Set([
  "productId", "automationState", "draftVersion", "listingRunId", "pricingRunId",
  "templateVersion", "orderedFinalAssetIds", "sourceItemId", "canonicalSuccessDetailId",
  "stock", "weightKg", "approvalState", "title"
]);

function safeValue(value: unknown): SafeConflictValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const values = value.map(safeValue);
    return values.every((item) => item !== undefined) ? values as SafeConflictValue[] : undefined;
  }
  return undefined;
}

export function conflictResponse(error: unknown): Response | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const nested = candidate.metadata && typeof candidate.metadata === "object"
    ? candidate.metadata as Record<string, unknown>
    : null;
  // Draft conflicts originate in this Web lane and retain the older top-level
  // shape. Approval conflicts must use Core's nested metadata shape.
  const metadata = code === "draft_version_conflict" ? (nested ?? candidate) : nested;
  if (!metadata) return null;
  const field = typeof metadata.field === "string" ? metadata.field : "";
  if (!/(?:stale|conflict)/.test(code) || !SAFE_FIELDS.has(field)) return null;
  const expected = safeValue(metadata.expected) ?? "material_changed";
  const actual = safeValue(metadata.actual) ?? "material_changed";
  return Response.json({ error: code, conflict: { field, expected, actual } }, { status: 409 });
}
