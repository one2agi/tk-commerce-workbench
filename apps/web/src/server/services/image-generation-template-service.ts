// Image generation template service: versioned draft lifecycle, activation, and category resolution.
//
// Editing an active template creates a new draft (version N+1); activation
// archives the currently-active version and promotes the selected draft.
//
// Business rules:
//   - A version is immutable once created.
//   - Only one version per template family may be "active".
//   - "restoreVersion" copies an immutable historical row into a new draft.
//   - "duplicate" creates a brand-new template family at version 1 (draft).

import { z } from "zod";
import { templateId as contractTemplateId } from "@tk/contracts/ids";
import type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";

// ---------------------------------------------------------------------------
// Recipe schema (strict validation for all mutation inputs)
// ---------------------------------------------------------------------------

const Counts = z.strictObject({
  default: z.number().int(),
  min: z.number().int(),
  max: z.number().int()
});

export const CategoryKeySchema = z.string().trim().min(1).max(120).regex(
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
  "categoryKey must use lowercase letters, numbers, dots, underscores, or hyphens"
);

export const RecipeSchema = z.strictObject({
  inputCounts: Counts.refine(
    (v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 6,
    { message: "inputCounts must have min≥1, default within [min,max], max≤6" }
  ),
  outputCounts: Counts.refine(
    (v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 8,
    { message: "outputCounts must have min≥1, default within [min,max], max≤8" }
  ),
  mustPreserve: z.array(z.string().trim().min(1).max(300)).max(50),
  visualDirection: z.string().trim().max(5_000),
  forbidden: z.array(z.string().trim().min(1).max(300)).max(50),
  roles: z
    .array(
      z.strictObject({
        key: z.string().trim().min(1).max(60),
        instruction: z.string().trim().min(1).max(1_000)
      })
    )
    .min(1)
    .max(8)
});

export type ValidatedRecipe = z.infer<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type LifecycleState = "draft" | "active" | "archived";

export type ImageGenerationTemplateVersion = Readonly<{
  id: string;
  templateId: string;
  version: number;
  lifecycleState: LifecycleState;
  recipe: ValidatedRecipe;
  activatedAt: Date | null;
  createdAt: Date;
}>;

export type ImageGenerationTemplate = Readonly<{
  id: string;
  name: string;
  categoryKey: string;
  parentCategoryKey: string | null;
  activeVersionId: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";

export type CategoryTemplateResolution = Readonly<{
  templateId: string;
  versionId: string;
  version: number;
  recipe: ValidatedRecipe;
}>;

// ---------------------------------------------------------------------------
// Store interface (allows PostgreSQL or in-memory implementation)
// ---------------------------------------------------------------------------

export interface ImageGenerationTemplateStore {
  createTemplate(input: {
    name: string;
    categoryKey: string;
    parentCategoryKey?: string;
  }): Promise<ImageGenerationTemplate>;

  createVersion(input: {
    templateId: string;
    version: number;
    lifecycleState: LifecycleState;
    recipe: ValidatedRecipe;
    activatedAt?: Date;
  }): Promise<ImageGenerationTemplateVersion>;

  getVersionsByTemplate(templateId: string): Promise<ImageGenerationTemplateVersion[]>;

  getVersion(versionId: string): Promise<ImageGenerationTemplateVersion | null>;

  getTemplate(templateId: string): Promise<ImageGenerationTemplate | null>;

  getTemplateByCategoryKey(categoryKey: string): Promise<ImageGenerationTemplate | null>;

  updateVersionArchived(version: ImageGenerationTemplateVersion): Promise<void>;

  updateTemplateActiveVersion(templateId: string, versionId: string): Promise<void>;

  listTemplates(): Promise<ImageGenerationTemplate[]>;

  resolveActiveByCategory(categoryKey: string): Promise<{
    template: ImageGenerationTemplate;
    version: ImageGenerationTemplateVersion;
  } | null>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ImageGenerationTemplateService {
  constructor(private readonly store: ImageGenerationTemplateStore) {}

  /**
   * Create a brand-new template family at version 1 (draft).
   */
  async createDraft(input: {
    name: string;
    categoryKey: string;
    parentCategoryKey?: string;
    recipe: ValidatedRecipe;
  }): Promise<ImageGenerationTemplateViewV1> {
    const categoryKey = CategoryKeySchema.parse(input.categoryKey);
    if (await this.store.getTemplateByCategoryKey(categoryKey)) {
      throw new Error("category_key_exists");
    }
    const template = await this.store.createTemplate({
      name: input.name,
      categoryKey,
      parentCategoryKey: input.parentCategoryKey
    });
    const version = await this.store.createVersion({
      templateId: template.id,
      version: 1,
      lifecycleState: "draft",
      recipe: input.recipe
    });
    return toView(template, version);
  }

  /**
   * Append a new immutable draft version based on the version the user edited.
   * Existing active and historical versions are never modified.
   */
  async updateDraft(input: {
    templateId: string;
    expectedVersion: number;
    visualDirection?: string;
    recipeOverride?: Partial<ValidatedRecipe>;
  }): Promise<ImageGenerationTemplateViewV1> {
    const template = await this.store.getTemplate(input.templateId);
    if (!template) throw new Error("template_not_found");

    const versions = await this.store.getVersionsByTemplate(input.templateId);
    const latestVersion = Math.max(...versions.map((version) => version.version));
    const source = versions.find((version) => version.version === input.expectedVersion
      && version.lifecycleState !== "archived")
      ?? versions.find((version) => version.version === input.expectedVersion);
    if (!source || latestVersion !== input.expectedVersion) {
      throw new Error("version_conflict");
    }

    const baseRecipe = source.recipe as ValidatedRecipe;
    const nextRecipe: ValidatedRecipe = {
      ...baseRecipe,
      ...(input.recipeOverride ?? {}),
      visualDirection: input.visualDirection ?? baseRecipe.visualDirection
    };

    const nextVersion = await this.store.createVersion({
      templateId: input.templateId,
      version: latestVersion + 1,
      lifecycleState: "draft",
      recipe: nextRecipe
    });

    const updatedTemplate = await this.store.getTemplate(input.templateId);
    return toView(updatedTemplate!, nextVersion);
  }

  /**
   * Activate a draft version: archives the currently-active version and
   * promotes the selected draft. Transactionally updates
   * image_generation_template_versions.lifecycle_state and
   * image_generation_templates.active_version_id.
   */
  async activate(templateId: string, version: number): Promise<ImageGenerationTemplateViewV1> {
    const versions = await this.store.getVersionsByTemplate(templateId);
    const toActivate = versions.find((v) => v.version === version && v.lifecycleState === "draft");
    if (!toActivate) throw new Error("draft_version_not_found");

    const currentActive = versions.find((v) => v.lifecycleState === "active");
    if (currentActive) {
      await this.store.updateVersionArchived(currentActive);
    }

    // Re-create the version as "active" (immutable — create new row)
    const activatedVersion = await this.store.createVersion({
      templateId,
      version: toActivate.version,
      lifecycleState: "active",
      recipe: toActivate.recipe,
      activatedAt: new Date()
    });

    await this.store.updateTemplateActiveVersion(templateId, activatedVersion.id);

    const template = await this.store.getTemplate(templateId);
    return toView(template!, activatedVersion);
  }

  /**
   * Archive a specific version (marks it as archived).
   */
  async archiveVersion(templateId: string, version: number): Promise<ImageGenerationTemplateViewV1> {
    const versions = await this.store.getVersionsByTemplate(templateId);
    const toArchive = versions.find((v) => v.version === version);
    if (!toArchive) throw new Error("version_not_found");

    await this.store.updateVersionArchived(toArchive);

    const updatedTemplate = await this.store.getTemplate(templateId);
    const activeVersion = toArchive.lifecycleState === "active"
      ? null
      : versions.find((v) => v.lifecycleState === "active");
    return toView(updatedTemplate!, activeVersion ?? toArchive);
  }

  /**
   * Restore an old version by copying it as a new draft (version N+1).
   */
  async restoreVersion(categoryKey: string, version: number): Promise<ImageGenerationTemplateViewV1> {
    const resolved = await this.store.resolveActiveByCategory(categoryKey);
    if (!resolved) throw new Error("template_not_found");

    const historical = (await this.store.getVersionsByTemplate(resolved.template.id)).find(
      (v) => v.version === version
    );
    if (!historical) throw new Error("version_not_found");

    const maxVersion = Math.max(
      ...(await this.store.getVersionsByTemplate(resolved.template.id)).map((v) => v.version)
    );

    const restored = await this.store.createVersion({
      templateId: resolved.template.id,
      version: maxVersion + 1,
      lifecycleState: "draft",
      recipe: historical.recipe
    });

    const template = await this.store.getTemplate(resolved.template.id);
    return toView(template!, restored);
  }

  /**
   * Duplicate a template family as a new draft family at version 1.
   * The source template is unchanged.
   */
  async duplicate(categoryKey: string, version: number): Promise<ImageGenerationTemplateViewV1> {
    const resolved = await this.store.resolveActiveByCategory(categoryKey);
    if (!resolved) throw new Error("template_not_found");

    const sourceVersions = await this.store.getVersionsByTemplate(resolved.template.id);
    const sourceVersion = sourceVersions.find((v) => v.version === version);
    if (!sourceVersion) throw new Error("version_not_found");

    const newTemplate = await this.store.createTemplate({
      name: `${resolved.template.name} 副本`,
      categoryKey: resolved.template.categoryKey,
      parentCategoryKey: resolved.template.parentCategoryKey ?? undefined
    });

    const newVersion = await this.store.createVersion({
      templateId: newTemplate.id,
      version: 1,
      lifecycleState: "draft",
      recipe: sourceVersion.recipe
    });

    return toView(newTemplate, newVersion);
  }

  /**
   * Resolve the active template version for a given category key.
   * Falls back from child categories to parent categories.
   */
  async resolveActive(categoryKey: string): Promise<CategoryTemplateResolution | null> {
    const resolved = await this.store.resolveActiveByCategory(categoryKey);
    if (!resolved) return null;
    return {
      templateId: resolved.template.id,
      versionId: resolved.version.id,
      version: resolved.version.version,
      recipe: resolved.version.recipe
    };
  }

  /**
   * List every meaningful version so new drafts and pending edits remain manageable.
   */
  async list(): Promise<{ items: ImageGenerationTemplateViewV1[] }> {
    const templates = await this.store.listTemplates();
    const items: ImageGenerationTemplateViewV1[] = [];

    for (const template of templates) {
      const versions = await this.store.getVersionsByTemplate(template.id);
      const byVersion = new Map<number, ImageGenerationTemplateVersion>();
      for (const version of versions) {
        const existing = byVersion.get(version.version);
        const priority = { archived: 0, draft: 1, active: 2 } as const;
        if (!existing || priority[version.lifecycleState] > priority[existing.lifecycleState]) {
          byVersion.set(version.version, version);
        }
      }
      for (const version of [...byVersion.values()].sort((a, b) => b.version - a.version)) {
        items.push(toView(template, version));
      }
    }

    return { items };
  }
}

function toView(
  template: ImageGenerationTemplate,
  version: ImageGenerationTemplateVersion
): ImageGenerationTemplateViewV1 {
  return Object.freeze({
    templateId: contractTemplateId(template.id),
    name: template.name,
    categoryKey: template.categoryKey,
    parentCategoryKey: template.parentCategoryKey,
    version: version.version,
    lifecycleState: version.lifecycleState,
    recipe: version.recipe,
    activatedAt: version.activatedAt ? version.activatedAt.toISOString() : null,
    createdAt: version.createdAt.toISOString()
  });
}
