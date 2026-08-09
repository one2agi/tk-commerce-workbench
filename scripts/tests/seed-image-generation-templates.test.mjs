import { describe, it } from "node:test";
import assert from "node:assert";

// Import the seed function - use default import
import seedImageGenerationTemplates from "../seed-image-generation-templates.mjs";

function createMockClient() {
  const templates = [];
  const versions = [];
  return {
    query: async (sql, params) => {
      // SELECT by name (with $1 param)
      if (sql.includes("SELECT") && sql.includes("image_generation_templates") && sql.includes("name = $1")) {
        return { rows: templates.filter(t => t.name === params[0]) };
      }
      // INSERT template: params = [templateId, name, categoryKey, parentCategoryKey]
      // Use params[0] as the actual template ID (must match what seed script uses)
      if (sql.includes("INSERT INTO image_generation_templates")) {
        const id = params[0]; // use actual templateId from seed script
        templates.push({ id, name: params[1], category_key: params[2], parent_category_key: params[3], enabled: true, active_version_id: null });
        return { rowCount: 1, rows: [{ id }] };
      }
      // INSERT version (params are [versionId, templateId, recipeJSON, activatedAt])
      if (sql.includes("INSERT INTO image_generation_template_versions")) {
        const id = params[0]; // use actual versionId from seed script
        const recipeParam = params[2];
        const recipe = typeof recipeParam === 'string' ? JSON.parse(recipeParam) : recipeParam;
        versions.push({ id, template_id: params[1], version: 1, lifecycle_state: 'active', recipe, activated_at: params[3] });
        const tpl = templates.find(t => t.id === params[1]);
        if (tpl) tpl.active_version_id = id;
        return { rowCount: 1, rows: [{ id }] };
      }
      // UPDATE template active_version_id
      // UPDATE SET active_version_id = $1 WHERE id = $2 => params[0] = versionId, params[1] = templateId
      if (sql.includes("UPDATE image_generation_templates")) {
        const tpl = templates.find(t => t.id === params[1]);
        if (tpl) tpl.active_version_id = params[0];
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
    _templates: templates,
    _versions: versions
  };
}

describe("seed-image-generation-templates", () => {
  it("seeds exactly one active version for generic, apparel, jewelry, and women.hat templates", async () => {
    const client = createMockClient();
    await seedImageGenerationTemplates(client);

    assert.strictEqual(client._templates.length, 4, "should have exactly 4 templates");

    const templateNames = ["generic", "apparel", "jewelry", "women.hat"];
    for (const name of templateNames) {
      const tpl = client._templates.find(t => t.name === name);
      assert.ok(tpl, `template ${name} should exist`);
      assert.ok(tpl.active_version_id, `template ${name} should have an active version`);
    }

    const activeVersions = client._versions.filter(v => v.lifecycle_state === "active");
    assert.strictEqual(activeVersions.length, 4, "should have exactly 4 active versions");
  });

  it("sets input counts within 1-6 range and output counts within 1-8 range", async () => {
    const client = createMockClient();
    await seedImageGenerationTemplates(client);

    for (const ver of client._versions) {
      const recipe = ver.recipe;
      assert.ok(recipe.inputCounts, "recipe should have inputCounts");
      assert.ok(recipe.outputCounts, "recipe should have outputCounts");

      assert.ok(recipe.inputCounts.min >= 1 && recipe.inputCounts.min <= 6, `inputCounts.min should be 1-6`);
      assert.ok(recipe.inputCounts.max >= 1 && recipe.inputCounts.max <= 6, `inputCounts.max should be 1-6`);
      assert.ok(recipe.inputCounts.default >= 1 && recipe.inputCounts.default <= 6, `inputCounts.default should be 1-6`);

      assert.ok(recipe.outputCounts.min >= 1 && recipe.outputCounts.min <= 8, `outputCounts.min should be 1-8`);
      assert.ok(recipe.outputCounts.max >= 1 && recipe.outputCounts.max <= 8, `outputCounts.max should be 1-8`);
      assert.ok(recipe.outputCounts.default >= 1 && recipe.outputCounts.default <= 8, `outputCounts.default should be 1-8`);
    }
  });

  it("seeds eight ordered roles for every template", async () => {
    const client = createMockClient();
    await seedImageGenerationTemplates(client);
    const expectedRoles = ["hero", "benefit", "scene", "detail", "audience", "alternate_scene", "sku_presentation", "packaging"];

    for (const ver of client._versions) {
      const recipe = ver.recipe;
      assert.ok(recipe.roles, "recipe should have roles array");
      assert.strictEqual(recipe.roles.length, 8, "should have exactly 8 roles");
      for (let i = 0; i < expectedRoles.length; i++) {
        assert.strictEqual(recipe.roles[i].key, expectedRoles[i], `role ${i} should be ${expectedRoles[i]}`);
      }
    }
  });

  it("idempotently re-runs without creating duplicate active versions", async () => {
    const client = createMockClient();

    await seedImageGenerationTemplates(client);
    await seedImageGenerationTemplates(client);

    assert.strictEqual(client._templates.length, 4, "should still have exactly 4 templates after re-run");

    const activeVersions = client._versions.filter(v => v.lifecycle_state === "active");
    assert.strictEqual(activeVersions.length, 4, "should still have exactly 4 active versions after re-run");
  });
});
