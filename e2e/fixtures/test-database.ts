import { randomUUID } from "node:crypto";

import pg from "../../packages/db/node_modules/pg/lib/index.js";

import { approveTestDatabaseUrl } from "../../packages/db/src/integration/guard.js";

export async function openE2eDatabase(rawUrl: string | undefined) {
  if (rawUrl?.startsWith("pglite://")) {
    throw new Error("G3 DB-backed E2E requires an explicit loopback PostgreSQL *_test database");
  }
  const approved = approveTestDatabaseUrl(rawUrl);
  const pool = new pg.Pool({ connectionString: approved.url, max: 4, connectionTimeoutMillis: 10_000 });
  await pool.query("SELECT 1");
  return {
    approved,
    pool,
    async reset() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
        await client.query(`CREATE SCHEMA "public"`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async migrate(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    }
  };
}

// ---------------------------------------------------------------------------
// Headless image-generation seed helpers
// ---------------------------------------------------------------------------
//
// These helpers seed a product + revision + N source assets plus the four
// headless schema tables (image_generation_templates,
// image_generation_template_versions, image_generation_batches,
// image_generation_slots) so E2E tests can run the brief's count matrix:
//
//   { inputs: 1, outputs: 1 }
//   { inputs: 3, outputs: 5 }
//   { inputs: 4, outputs: 5 }
//   { inputs: 6, outputs: 8 }
//
// Existing fixtures (openE2eDatabase, reset, migrate) are untouched — these
// helpers extend, never replace, prior functionality.

export interface HeadlessBatchSeed {
  productId: string;
  revisionId: string;
  batchId: string;
  inputAssetIds: string[];
  slotIds: string[];
}

export interface SeedHeadlessBatchOptions {
  /** Number of local source images to attach (1..6 per the brief). */
  inputCount: number;
  /** Number of output slots to create (1..8 per the brief). */
  outputCount: number;
  /** Optional operator override; defaults to "op_e2e". */
  operatorId?: string;
  /** Optional product id; a unique id is generated when omitted. */
  productId?: string;
  /** Initial batch state. Defaults to "generating" so tests can recover. */
  batchState?: string;
}

/**
 * Insert a product with N local source images and a complete headless batch
 * with the requested number of output slots. The seed is idempotent w.r.t.
 * the (template_id, version) tuple so re-runs in a single test session
 * never fail; product/revision/batch ids are always fresh to avoid cross-test
 * bleed.
 */
export async function seedHeadlessBatchForProduct(
  pool: import("pg").Pool,
  options: SeedHeadlessBatchOptions
): Promise<HeadlessBatchSeed> {
  const inputCount = options.inputCount;
  const outputCount = options.outputCount;
  const operatorId = options.operatorId ?? "op_e2e";
  const batchState = options.batchState ?? "generating";

  if (inputCount < 1 || inputCount > 6) {
    throw new Error(`seedHeadlessBatchForProduct: inputCount must be 1..6, got ${inputCount}`);
  }
  if (outputCount < 1 || outputCount > 8) {
    throw new Error(`seedHeadlessBatchForProduct: outputCount must be 1..8, got ${outputCount}`);
  }

  const productId = options.productId ?? `prod_headless_${randomUUID().slice(0, 8)}`;
  const revisionId = `rev_${randomUUID().slice(0, 8)}`;
  const batchId = `batch_${randomUUID().slice(0, 8)}`;
  const templateVersionId = "ig_tmpl_v1";
  const recipe = JSON.stringify({
    version: 1,
    inputCount,
    outputCount,
    mustPreserve: ["product identity"],
    visualDirection: "clean marketplace photography",
    forbidden: ["brand logos"],
    roles: [{ key: "default", instruction: "show the product clearly" }],
    providerParameters: {}
  });

  await pool.query(
    `INSERT INTO local_operators (id, handle, display_name)
     VALUES ($1, 'e2e-operator', 'E2E Operator')
     ON CONFLICT (handle) DO NOTHING;`,
    [operatorId]
  );

  await pool.query(
    `INSERT INTO products
       (id, operator_id, source_url, source_item_id, canonical_success_detail_id,
        locale, currency, state_source, state_automation)
     VALUES ($1, $2, 'https://detail.1688.com/offer/892408514788.html',
             '892408514788', '3799770548', 'th-TH', 'THB', 'success', 'not_started')`,
    [productId, operatorId]
  );

  await pool.query(
    `INSERT INTO product_revisions (id, product_id, draft_version, source_title, source_payload, working_draft)
     VALUES ($1, $2, 1, '测试商品', '{"mainImages":[],"detailImages":[]}'::jsonb, '{}')`,
    [revisionId, productId]
  );

  const inputAssetIds: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    const assetId = `asset_${randomUUID().slice(0, 8)}_${i}`;
    inputAssetIds.push(assetId);
    await pool.query(
      `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, width, height, local_path, extension)
       VALUES ($1, $2, $3, $4, 'main', 'ready', 1200, 1200, $5, 'jpg')`,
      [
        assetId,
        productId,
        revisionId,
        `https://cbu01.alicdn.com/img/ibank/O${i}.jpg`,
        `/data/assets/seed_${i}.jpg`
      ]
    );
  }

  await pool.query(
    `INSERT INTO image_generation_templates
       (id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at)
     VALUES ('ig_tmpl_1', 'Headless Test', '服装', NULL, NULL, true, NULL, now(), now())
     ON CONFLICT (id) DO NOTHING;`,
    []
  );
  await pool.query(
    `INSERT INTO image_generation_template_versions
       (id, template_id, version, lifecycle_state, recipe, activated_at, created_at)
     VALUES ($1, 'ig_tmpl_1', 1, 'active',
             $2::jsonb,
             now(), now())
     ON CONFLICT (template_id, version) DO NOTHING;`,
    [templateVersionId, recipe]
  );
  await pool.query(
    `UPDATE image_generation_templates SET active_version_id = $1 WHERE id = 'ig_tmpl_1'`,
    [templateVersionId]
  );

  await pool.query(
    `INSERT INTO image_generation_batches
       (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count,
        category_key, template_id, template_version_id, template_version, recipe_snapshot,
        product_facts_snapshot, product_facts_digest, state, accepted_asset_ids, created_at, updated_at)
     VALUES ($1, $2, $3, $1, $4, $5, '服装', 'ig_tmpl_1', $6, 1,
             $8::jsonb,
             '{}', 'digest_${randomUUID().slice(0, 8)}', $7, '[]', now(), now())`,
    [batchId, productId, revisionId, JSON.stringify(inputAssetIds), outputCount, templateVersionId, batchState, recipe]
  );

  const slotIds: string[] = [];
  for (let i = 0; i < outputCount; i++) {
    const slotId = `slot_${batchId}_${i + 1}`;
    slotIds.push(slotId);
    await pool.query(
      `INSERT INTO image_generation_slots
         (id, batch_id, slot_number, role, prompt, prompt_hash, business_key, state, attempt,
          remote_task_id, remote_output_url, archived_asset_id, error, excluded_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'default', NULL, NULL, $4, 'queued', 0, NULL, NULL, NULL, NULL, NULL, now(), now())`,
      [slotId, batchId, i + 1, `slot:${batchId}:${i + 1}`]
    );
  }

  return { productId, revisionId, batchId, inputAssetIds, slotIds };
}

/**
 * Convenience for the count matrix: returns a pre-seeded batch for each of
 * the brief Step 1 scenarios.
 */
export async function seedCountMatrixBatches(
  pool: import("pg").Pool
): Promise<Array<HeadlessBatchSeed & { inputCount: number; outputCount: number }>> {
  const matrix: Array<{ inputs: number; outputs: number }> = [
    { inputs: 1, outputs: 1 },
    { inputs: 3, outputs: 5 },
    { inputs: 4, outputs: 5 },
    { inputs: 6, outputs: 8 }
  ];
  const seeded: Array<HeadlessBatchSeed & { inputCount: number; outputCount: number }> = [];
  for (const scenario of matrix) {
    const seed = await seedHeadlessBatchForProduct(pool, {
      inputCount: scenario.inputs,
      outputCount: scenario.outputs
    });
    seeded.push({ ...seed, inputCount: scenario.inputs, outputCount: scenario.outputs });
  }
  return seeded;
}
