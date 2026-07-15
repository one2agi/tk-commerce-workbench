import { assetId, templateId } from "@tk/contracts/ids";
import type { TemplateV1 } from "@tk/contracts/read-models";

import type { QueryPort } from "./product-service";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class TemplateService {
  constructor(private readonly database: QueryPort) {}

  async list(): Promise<{ items: TemplateV1[] }> {
    const result = await this.database.query(
      `SELECT id, name, category_rules, reference_asset_ids, prompt_fragment,
              target_locale, visual_style, enabled, version
       FROM templates ORDER BY enabled DESC, name ASC, version DESC`
    );
    return {
      items: result.rows.map((row) => ({
        templateId: templateId(String(row.id)),
        name: String(row.name),
        categoryRules: Array.isArray(row.category_rules)
          ? row.category_rules as Array<{ categoryKey: string; priority: number }>
          : [],
        referenceAssetIds: strings(row.reference_asset_ids).map(assetId),
        promptFragment: typeof row.prompt_fragment === "string" ? row.prompt_fragment : "",
        targetLocale: String(row.target_locale),
        visualStyle: typeof row.visual_style === "string" ? row.visual_style : "",
        enabled: row.enabled === true,
        version: Number(row.version)
      }))
    };
  }
}
