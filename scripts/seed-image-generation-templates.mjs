/**
 * Seeds initial image generation templates for generic, apparel, jewelry, and women's hat categories.
 * Uses the approved preservation hierarchy: no Canvas coordinates, cached model output,
 * placeholder images, node IDs, or jewelry-specific prior runtime output.
 *
 * Each template has:
 * - 3 inputs (default), range 1-6
 * - 5 outputs (default), range 1-8
 * - 8 ordered roles: hero, benefit, scene, detail, audience, alternate_scene, sku_presentation, packaging
 */

const EIGHT_ROLES = [
  { key: "hero", instruction: "Primary hero shot showcasing the product as the focal point" },
  { key: "benefit", instruction: "Highlight the key benefit or unique selling proposition" },
  { key: "scene", instruction: "Product shown in an appealing lifestyle or contextual scene" },
  { key: "detail", instruction: "Close-up detail shot emphasizing quality and craftsmanship" },
  { key: "audience", instruction: "Appeal to the target audience's aspirations and use case" },
  { key: "alternate_scene", instruction: "Alternative scene or setting for variety" },
  { key: "sku_presentation", instruction: "SKU or inventory-style presentation showing multiple angles" },
  { key: "packaging", instruction: "Product packaging or unboxing presentation" }
];

const TEMPLATES = [
  {
    name: "generic",
    categoryKey: "generic",
    parentCategoryKey: null,
    recipe: {
      inputCounts: { default: 3, min: 1, max: 6 },
      outputCounts: { default: 5, min: 1, max: 8 },
      mustPreserve: [],
      visualDirection: "Clean, professional product photography style",
      forbidden: ["text overlays", "watermarks", "distracting backgrounds"],
      roles: EIGHT_ROLES
    }
  },
  {
    name: "apparel",
    categoryKey: "apparel",
    parentCategoryKey: null,
    recipe: {
      inputCounts: { default: 3, min: 1, max: 6 },
      outputCounts: { default: 5, min: 1, max: 8 },
      mustPreserve: ["color", "material texture"],
      visualDirection: "Fashion-forward styling with attention to fabric drape and fit",
      forbidden: ["mannequin ghosts", "AI-generated faces without disclosure"],
      roles: EIGHT_ROLES
    }
  },
  {
    name: "jewelry",
    categoryKey: "jewelry",
    parentCategoryKey: null,
    recipe: {
      inputCounts: { default: 3, min: 1, max: 6 },
      outputCounts: { default: 5, min: 1, max: 8 },
      mustPreserve: ["metal finish", "stone clarity", "setting style"],
      visualDirection: "Elegant jewelry photography with emphasis on sparkle and craftsmanship",
      forbidden: ["busy backgrounds", "mixed metals in same image"],
      roles: EIGHT_ROLES
    }
  },
  {
    name: "women.hat",
    categoryKey: "women.hat",
    parentCategoryKey: "women.accessories",
    recipe: {
      inputCounts: { default: 3, min: 1, max: 6 },
      outputCounts: { default: 5, min: 1, max: 8 },
      mustPreserve: ["hat shape", " brim details"],
      visualDirection: "Stylish hat presentation showcasing form and seasonal appeal",
      forbidden: ["obscuring the hat crown", "clashing style contexts"],
      roles: EIGHT_ROLES
    }
  }
];

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {import('pg').PoolClient | { query: Function, release: Function }} client
 */
export default async function seedImageGenerationTemplates(client) {
  for (const tpl of TEMPLATES) {
    // Check if template already exists
    const existing = await client.query(
      `SELECT id, active_version_id FROM image_generation_templates WHERE name = $1`,
      [tpl.name]
    );

    let templateId;
    if (existing.rows.length > 0) {
      // Template exists, skip if it already has an active version
      templateId = existing.rows[0].id;
      if (existing.rows[0].active_version_id) {
        continue; // Already seeded with active version
      }
    } else {
      // Create new template
      templateId = newId("tpl");
      await client.query(
        `INSERT INTO image_generation_templates (id, name, category_key, parent_category_key, enabled)
         VALUES ($1, $2, $3, $4, true)`,
        [templateId, tpl.name, tpl.categoryKey, tpl.parentCategoryKey]
      );
    }

    // Create active version
    const versionId = newId("ver");
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO image_generation_template_versions
       (id, template_id, version, lifecycle_state, recipe, activated_at)
       VALUES ($1, $2, 1, 'active', $3::jsonb, $4)`,
      [versionId, templateId, JSON.stringify(tpl.recipe), now]
    );

    // Link active version to template
    await client.query(
      `UPDATE image_generation_templates SET active_version_id = $1 WHERE id = $2`,
      [versionId, templateId]
    );
  }
}

// Allow running directly with node
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    await seedImageGenerationTemplates(client);
    client.release();
    console.log("Seeded image generation templates successfully");
  } finally {
    await pool.end();
  }
}
