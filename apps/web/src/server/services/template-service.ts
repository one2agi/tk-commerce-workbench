import { randomUUID } from "node:crypto";

import { assetId, templateId } from "@tk/contracts/ids";
import type { TemplateV1 } from "@tk/contracts/read-models";
import type { DbPool } from "../../../../../packages/db/src/schema/index.js";

export type CategoryRule = Readonly<{ categoryKey: string; priority: number }>;
export type TemplateRecord = Readonly<{
  recordId: string;
  templateId: string;
  name: string;
  categoryRules: CategoryRule[];
  referenceAssetIds: string[];
  promptFragment: string;
  targetLocale: string;
  visualStyle: string;
  enabled: boolean;
  version: number;
}>;
export type TemplateCreate = Omit<TemplateRecord, "recordId" | "templateId" | "version">;
export type TemplateUpdate = Readonly<Partial<TemplateCreate> & {
  templateId: string;
  expectedVersion: number;
}>;

export interface TemplateStore {
  list(): Promise<TemplateRecord[]>;
  create(record: TemplateRecord): Promise<TemplateRecord>;
  appendVersion(
    templateId: string,
    expectedVersion: number,
    record: TemplateRecord
  ): Promise<TemplateRecord | undefined>;
}

export class TemplateConflictError extends Error {
  constructor(readonly actualVersion: number | null) {
    super("template_version_conflict");
  }
}

export class TemplateService {
  constructor(
    private readonly store: TemplateStore,
    private readonly createId: () => string = randomUUID
  ) {}

  async list(): Promise<{ items: TemplateV1[] }> {
    return { items: (await this.store.list()).map(toView) };
  }

  async create(input: TemplateCreate): Promise<TemplateV1> {
    const familyId = `template_${this.createId()}`;
    return toView(await this.store.create({
      ...copyTemplateInput(input),
      recordId: `template_version_${this.createId()}`,
      templateId: familyId,
      version: 1
    }));
  }

  async update(command: TemplateUpdate): Promise<TemplateV1> {
    const history = (await this.store.list()).filter((item) => item.templateId === command.templateId);
    const latest = history.sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.version !== command.expectedVersion) {
      throw new TemplateConflictError(latest?.version ?? null);
    }
    const next: TemplateRecord = {
      ...latest,
      ...copyTemplateInput({
        name: command.name ?? latest.name,
        categoryRules: command.categoryRules ?? latest.categoryRules,
        referenceAssetIds: command.referenceAssetIds ?? latest.referenceAssetIds,
        promptFragment: command.promptFragment ?? latest.promptFragment,
        targetLocale: command.targetLocale ?? latest.targetLocale,
        visualStyle: command.visualStyle ?? latest.visualStyle,
        enabled: command.enabled ?? latest.enabled
      }),
      recordId: `template_version_${this.createId()}`,
      version: latest.version + 1
    };
    const appended = await this.store.appendVersion(command.templateId, command.expectedVersion, next);
    if (!appended) {
      const actual = (await this.store.list())
        .filter((item) => item.templateId === command.templateId)
        .sort((a, b) => b.version - a.version)[0];
      throw new TemplateConflictError(actual?.version ?? null);
    }
    return toView(appended);
  }
}

export class PgTemplateStore implements TemplateStore {
  constructor(private readonly pool: DbPool) {}

  async list(): Promise<TemplateRecord[]> {
    const result = await this.pool.query(
      `SELECT id, template_key, name, category_rules, reference_asset_ids, prompt_fragment,
              target_locale, visual_style, enabled, version
       FROM templates ORDER BY template_key ASC, version DESC, created_at DESC`
    );
    return result.rows.map((row) => mapRecord(row as Record<string, unknown>));
  }

  async create(record: TemplateRecord): Promise<TemplateRecord> {
    await this.pool.query(
      `INSERT INTO templates
        (id, template_key, name, category_rules, reference_asset_ids, prompt_fragment,
         target_locale, visual_style, enabled, version)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      values(record)
    );
    return record;
  }

  async appendVersion(templateKey: string, expectedVersion: number, record: TemplateRecord) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const latest = await client.query<{ version: number }>(
        `SELECT version FROM templates WHERE template_key = $1
         ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [templateKey]
      );
      if (Number(latest.rows[0]?.version) !== expectedVersion) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `INSERT INTO templates
          (id, template_key, name, category_rules, reference_asset_ids, prompt_fragment,
           target_locale, visual_style, enabled, version)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
        values(record)
      );
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") return undefined;
      throw error;
    } finally {
      client.release();
    }
  }
}

function values(record: TemplateRecord): unknown[] {
  return [record.recordId, record.templateId, record.name, JSON.stringify(record.categoryRules),
    JSON.stringify(record.referenceAssetIds), record.promptFragment, record.targetLocale,
    record.visualStyle, record.enabled, record.version];
}

function copyTemplateInput(input: TemplateCreate): TemplateCreate {
  return {
    ...input,
    categoryRules: input.categoryRules.map((rule) => ({ ...rule })),
    referenceAssetIds: [...input.referenceAssetIds]
  };
}

function toView(row: TemplateRecord): TemplateV1 {
  return {
    templateId: templateId(row.templateId),
    name: row.name,
    categoryRules: row.categoryRules.map((rule) => ({ ...rule })),
    referenceAssetIds: row.referenceAssetIds.map(assetId),
    promptFragment: row.promptFragment,
    targetLocale: row.targetLocale,
    visualStyle: row.visualStyle,
    enabled: row.enabled,
    version: row.version
  };
}

function mapRecord(row: Record<string, unknown>): TemplateRecord {
  return {
    recordId: String(row.id),
    templateId: String(row.template_key),
    name: String(row.name),
    categoryRules: Array.isArray(row.category_rules) ? row.category_rules as CategoryRule[] : [],
    referenceAssetIds: Array.isArray(row.reference_asset_ids)
      ? row.reference_asset_ids.filter((item): item is string => typeof item === "string")
      : [],
    promptFragment: typeof row.prompt_fragment === "string" ? row.prompt_fragment : "",
    targetLocale: String(row.target_locale),
    visualStyle: typeof row.visual_style === "string" ? row.visual_style : "",
    enabled: row.enabled === true,
    version: Number(row.version)
  };
}
