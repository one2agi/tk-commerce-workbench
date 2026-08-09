import { describe, expect, it } from "vitest";
import { ImageGenerationTemplateService, type ValidatedRecipe } from "./image-generation-template-service";

// In-memory store for testing
type TemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  lifecycleState: "draft" | "active" | "archived";
  recipe: ValidatedRecipe;
  activatedAt: Date | null;
  createdAt: Date;
};

type Template = {
  id: string;
  name: string;
  categoryKey: string;
  parentCategoryKey: string | null;
  activeVersionId: string | null;
  enabled: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createInMemoryStore() {
  const templates: Map<string, Template> = new Map();
  const versions: Map<string, TemplateVersion> = new Map();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  return {
    async createTemplate(input: {
      name: string;
      categoryKey: string;
      parentCategoryKey?: string;
    }): Promise<Template> {
      const id = nextId("tmpl");
      const now = new Date();
      const template: Template = {
        id,
        name: input.name,
        categoryKey: input.categoryKey,
        parentCategoryKey: input.parentCategoryKey ?? null,
        activeVersionId: null,
        enabled: true,
        archivedAt: null,
        createdAt: now,
        updatedAt: now
      };
      templates.set(id, template);
      return template;
    },

    async createVersion(input: {
      templateId: string;
      version: number;
      lifecycleState: "draft" | "active" | "archived";
      recipe: ValidatedRecipe;
      activatedAt?: Date;
    }): Promise<TemplateVersion> {
      const id = nextId("ver");
      const now = new Date();
      const v: TemplateVersion = {
        id,
        templateId: input.templateId,
        version: input.version,
        lifecycleState: input.lifecycleState,
        recipe: input.recipe,
        activatedAt: input.activatedAt ?? null,
        createdAt: now
      };
      versions.set(id, v);
      if (input.lifecycleState === "active") {
        const t = templates.get(input.templateId)!;
        templates.set(input.templateId, { ...t, activeVersionId: id, updatedAt: now });
      }
      return v;
    },

    async getVersionsByTemplate(templateId: string): Promise<TemplateVersion[]> {
      return Array.from(versions.values())
        .filter((v) => v.templateId === templateId)
        .sort((a, b) => b.version - a.version);
    },

    async getVersion(versionId: string): Promise<TemplateVersion | null> {
      return versions.get(versionId) ?? null;
    },

    async getTemplate(templateId: string): Promise<Template | null> {
      return templates.get(templateId) ?? null;
    },

    async getTemplateByCategoryKey(categoryKey: string): Promise<Template | null> {
      return Array.from(templates.values()).find((t) => t.categoryKey === categoryKey && !t.archivedAt) ?? null;
    },

    async updateVersionArchived(prev: TemplateVersion): Promise<void> {
      versions.set(prev.id, { ...prev, lifecycleState: "archived" });
    },

    async updateTemplateActiveVersion(templateId: string, versionId: string): Promise<void> {
      const t = templates.get(templateId)!;
      templates.set(templateId, { ...t, activeVersionId: versionId, updatedAt: new Date() });
    },

    async listTemplates(): Promise<Template[]> {
      return Array.from(templates.values());
    },

    async resolveActiveByCategory(categoryKey: string): Promise<{ template: Template; version: TemplateVersion } | null> {
      // Try exact match then parent
      const candidates = Array.from(templates.values()).filter(
        (t) => (t.categoryKey === categoryKey || categoryKey.startsWith(t.categoryKey + ".")) && !t.archivedAt
      );
      if (!candidates.length) return null;
      const tmpl = candidates.sort((a, b) => b.categoryKey.length - a.categoryKey.length)[0];
      if (!tmpl.activeVersionId) return null;
      const ver = versions.get(tmpl.activeVersionId)!;
      return { template: tmpl, version: ver };
    }
  };
}

const minimalRecipe: ValidatedRecipe = {
  inputCounts: { default: 2, min: 1, max: 6 },
  outputCounts: { default: 3, min: 1, max: 8 },
  mustPreserve: [],
  visualDirection: "",
  forbidden: [],
  roles: [
    { key: "hero", instruction: "Primary hero shot" },
    { key: "detail", instruction: "Detail view" },
    { key: "lifestyle", instruction: "Lifestyle shot" }
  ]
};

describe("ImageGenerationTemplateService lifecycle", () => {
  it("rejects a duplicate category key before creating another template family", async () => {
    const store = createInMemoryStore();
    const service = new ImageGenerationTemplateService({
      createTemplate: store.createTemplate.bind(store), createVersion: store.createVersion.bind(store),
      getVersionsByTemplate: store.getVersionsByTemplate.bind(store), getVersion: store.getVersion.bind(store),
      getTemplate: store.getTemplate.bind(store), updateVersionArchived: store.updateVersionArchived.bind(store),
      updateTemplateActiveVersion: store.updateTemplateActiveVersion.bind(store), listTemplates: store.listTemplates.bind(store),
      resolveActiveByCategory: store.resolveActiveByCategory.bind(store), getTemplateByCategoryKey: store.getTemplateByCategoryKey.bind(store)
    });

    await service.createDraft({ name: "Hat A", categoryKey: "women.hat", recipe: minimalRecipe });

    await expect(service.createDraft({ name: "Hat B", categoryKey: "women.hat", recipe: minimalRecipe }))
      .rejects.toThrow("category_key_exists");
    expect(await store.listTemplates()).toHaveLength(1);
  });

  it("editing an active version appends a draft and leaves active unchanged", async () => {
    const store = createInMemoryStore();
    const service = new ImageGenerationTemplateService({
      createTemplate: store.createTemplate.bind(store),
      createVersion: store.createVersion.bind(store),
      getVersionsByTemplate: store.getVersionsByTemplate.bind(store),
      getVersion: store.getVersion.bind(store),
      getTemplate: store.getTemplate.bind(store),
      updateVersionArchived: store.updateVersionArchived.bind(store),
      updateTemplateActiveVersion: store.updateTemplateActiveVersion.bind(store),
      listTemplates: store.listTemplates.bind(store),
      resolveActiveByCategory: store.resolveActiveByCategory.bind(store),
      getTemplateByCategoryKey: store.getTemplateByCategoryKey.bind(store)
    });

    const tmpl = await store.createTemplate({ name: "Women's hat", categoryKey: "women.hat" });
    const v1 = await store.createVersion({
      templateId: tmpl.id, version: 1, lifecycleState: "active",
      recipe: minimalRecipe, activatedAt: new Date()
    });
    await store.updateTemplateActiveVersion(tmpl.id, v1.id);

    const draft = await service.updateDraft({
      templateId: tmpl.id,
      expectedVersion: 1,
      visualDirection: "Beach vacation"
    });

    expect(draft.lifecycleState).toBe("draft");
    expect(draft.version).toBe(2);
    const active = await store.getVersion(v1.id);
    expect(active!.lifecycleState).toBe("active");
  });

  it("lists a newly created draft and appends edits without mutating it", async () => {
    const store = createInMemoryStore();
    const service = new ImageGenerationTemplateService({
      createTemplate: store.createTemplate.bind(store), createVersion: store.createVersion.bind(store),
      getVersionsByTemplate: store.getVersionsByTemplate.bind(store), getVersion: store.getVersion.bind(store),
      getTemplate: store.getTemplate.bind(store), updateVersionArchived: store.updateVersionArchived.bind(store),
      updateTemplateActiveVersion: store.updateTemplateActiveVersion.bind(store), listTemplates: store.listTemplates.bind(store),
      resolveActiveByCategory: store.resolveActiveByCategory.bind(store), getTemplateByCategoryKey: store.getTemplateByCategoryKey.bind(store)
    });
    const created = await service.createDraft({ name: "Hat", categoryKey: "women.hat", recipe: minimalRecipe });
    expect((await service.list()).items).toEqual([expect.objectContaining({ version: 1, lifecycleState: "draft" })]);

    const edited = await service.updateDraft({
      templateId: created.templateId,
      expectedVersion: 1,
      recipeOverride: { visualDirection: "Beach holiday" }
    });

    expect(edited).toMatchObject({ version: 2, lifecycleState: "draft" });
    expect((await store.getVersionsByTemplate(created.templateId))[0]?.recipe.visualDirection).toBe("");
  });

  it("restores an old version by copying it to a new draft", async () => {
    const store = createInMemoryStore();
    const service = new ImageGenerationTemplateService({
      createTemplate: store.createTemplate.bind(store),
      createVersion: store.createVersion.bind(store),
      getVersionsByTemplate: store.getVersionsByTemplate.bind(store),
      getVersion: store.getVersion.bind(store),
      getTemplate: store.getTemplate.bind(store),
      updateVersionArchived: store.updateVersionArchived.bind(store),
      updateTemplateActiveVersion: store.updateTemplateActiveVersion.bind(store),
      listTemplates: store.listTemplates.bind(store),
      resolveActiveByCategory: store.resolveActiveByCategory.bind(store),
      getTemplateByCategoryKey: store.getTemplateByCategoryKey.bind(store)
    });

    const tmpl = await store.createTemplate({ name: "Women's hat", categoryKey: "women.hat" });
    const v1 = await store.createVersion({
      templateId: tmpl.id, version: 1, lifecycleState: "active",
      recipe: minimalRecipe, activatedAt: new Date()
    });
    await store.updateTemplateActiveVersion(tmpl.id, v1.id);

    const restored = await service.restoreVersion("women.hat", 1);

    expect(restored.lifecycleState).toBe("draft");
    expect(restored.version).toBe(2);
  });

  it("duplicates into a new draft family without changing the source", async () => {
    const store = createInMemoryStore();
    const service = new ImageGenerationTemplateService({
      createTemplate: store.createTemplate.bind(store),
      createVersion: store.createVersion.bind(store),
      getVersionsByTemplate: store.getVersionsByTemplate.bind(store),
      getVersion: store.getVersion.bind(store),
      getTemplate: store.getTemplate.bind(store),
      updateVersionArchived: store.updateVersionArchived.bind(store),
      updateTemplateActiveVersion: store.updateTemplateActiveVersion.bind(store),
      listTemplates: store.listTemplates.bind(store),
      resolveActiveByCategory: store.resolveActiveByCategory.bind(store),
      getTemplateByCategoryKey: store.getTemplateByCategoryKey.bind(store)
    });

    const tmpl = await store.createTemplate({ name: "Women's hat", categoryKey: "women.hat" });
    const v1 = await store.createVersion({
      templateId: tmpl.id, version: 1, lifecycleState: "active",
      recipe: minimalRecipe, activatedAt: new Date()
    });
    await store.updateTemplateActiveVersion(tmpl.id, v1.id);

    const copy = await service.duplicate("women.hat", 1);

    expect(copy.lifecycleState).toBe("draft");
    expect(copy.version).toBe(1);
    expect(copy.name).toBe("Women's hat 副本");
    expect(copy.templateId).not.toBe(tmpl.id);

    const original = await store.resolveActiveByCategory("women.hat");
    expect(original!.template.id).toBe(tmpl.id);
  });
});
