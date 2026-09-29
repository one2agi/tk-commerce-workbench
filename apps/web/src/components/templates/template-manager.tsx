import type { TemplateV1 } from "@tk/contracts/read-models";

function parseRules(value: FormDataEntryValue | null) {
  return String(value ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => ({
    categoryKey: line,
    priority: 100 - index
  }));
}

function parseAssets(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function fields(data: FormData) {
  return {
    name: data.get("name"),
    categoryRules: parseRules(data.get("categoryRules")),
    referenceAssetIds: parseAssets(data.get("referenceAssetIds")),
    promptFragment: data.get("promptFragment"),
    targetLocale: data.get("targetLocale"),
    visualStyle: data.get("visualStyle"),
    enabled: data.get("enabled") === "on"
  };
}

export async function saveTemplate(
  fetcher: typeof fetch,
  template: TemplateV1 | undefined,
  data: FormData
): Promise<{ ok: true; value: TemplateV1 } | { ok: false; status: number }> {
  const response = await fetcher("/api/v1/templates", {
    method: template ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(template ? {
      templateId: template.templateId,
      expectedVersion: template.version,
      ...fields(data)
    } : fields(data))
  });
  return response.ok
    ? { ok: true, value: await response.json() as TemplateV1 }
    : { ok: false, status: response.status };
}
