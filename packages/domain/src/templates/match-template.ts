export interface MatchableTemplate {
  id: string;
  enabled: boolean;
  rules: Array<{ category: string; priority: number }>;
}

export function matchTemplate<T extends MatchableTemplate>(input: {
  category: string | null;
  templates: ReadonlyArray<T>;
  defaultTemplateId: string;
}): T & { fallbackUsed: boolean } {
  const matches = input.templates
    .filter((template) => template.enabled)
    .flatMap((template) => template.rules
      .filter((rule) => input.category !== null && rule.category === input.category)
      .map((rule) => ({ template, priority: rule.priority })))
    .sort((a, b) => b.priority - a.priority || a.template.id.localeCompare(b.template.id));
  if (matches[0]) return { ...matches[0].template, fallbackUsed: false };
  const fallback = input.templates.find((template) => template.enabled && template.id === input.defaultTemplateId);
  if (!fallback) throw new Error("workspace default template is unavailable");
  return { ...fallback, fallbackUsed: true };
}
