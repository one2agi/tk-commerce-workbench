export function resolveCategoryTemplate(
  categoryKey: string,
  activeTemplates: Array<{ templateId: string; categoryKey: string; activeVersionId: string }>
) {
  // Try exact match
  const exact = activeTemplates.find((t) => t.categoryKey === categoryKey);
  if (exact) return exact;

  // Try parent categories (closest first)
  const parts = categoryKey.split(".");
  while (parts.length > 1) {
    parts.pop();
    const parentKey = parts.join(".");
    const parent = activeTemplates.find((t) => t.categoryKey === parentKey);
    if (parent) return parent;
  }

  // Fall back to generic
  return activeTemplates.find((t) => t.categoryKey === "generic") ?? null;
}
