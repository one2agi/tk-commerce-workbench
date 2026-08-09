import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { openE2eDatabase } from "./fixtures/test-database.js";

let database: Awaited<ReturnType<typeof openE2eDatabase>>;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test.beforeAll(async () => {
  database = await openE2eDatabase(process.env.TEST_DATABASE_URL);
  await database.reset();
  await database.migrate(await readFile(resolve(process.cwd(), "packages/db/drizzle/0000_initial.sql"), "utf8"));
  await database.pool.query(`
    INSERT INTO local_operators (id, handle, display_name) VALUES ('op_image_ui', 'image-ui', 'Image UI');
    INSERT INTO products
      (id, operator_id, source_url, source_item_id, canonical_success_detail_id, locale, currency, state_source, state_automation)
    VALUES
      ('product_image_result', 'op_image_ui', 'https://detail.1688.com/offer/3853105827.html', '3853105827', '3853105827', 'th-TH', 'THB', 'success', 'not_started'),
      ('product_image_start', 'op_image_ui', 'https://detail.1688.com/offer/3853105999.html', '3853105999', NULL, 'th-TH', 'THB', 'success', 'not_started');
    INSERT INTO product_revisions (id, product_id, draft_version, source_title, source_payload, working_draft)
    VALUES
      ('revision_image_result', 'product_image_result', 1, '蕾丝蝴蝶结大帽檐遮阳草帽',
       '{"category":"women.hat","mainImages":[{"url":"https://source.test/hat-1.jpg"},{"url":"https://source.test/hat-2.jpg"}],"detailImages":[{"url":"https://source.test/hat-3.jpg"}]}'::jsonb, '{}'),
      ('revision_image_start', 'product_image_start', 1, '待洗图草帽',
       '{"category":"women.hat","mainImages":[{"url":"https://source.test/start-1.jpg"},{"url":"https://source.test/start-2.jpg"}],"detailImages":[]}'::jsonb, '{}');
    INSERT INTO listing_drafts (id, product_id, revision_id, draft_version, target_locale, style, title, description)
    VALUES ('listing_image_result', 'product_image_result', 'revision_image_result', 1, 'th-TH', 'marketplace', 'หมวกกันแดด', 'รายละเอียด');
    INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, width, height, local_path, extension)
    VALUES
      ('asset_hat_1', 'product_image_result', 'revision_image_result', 'https://source.test/hat-1.jpg', 'main', 'ready', 1200, 1200, '/tmp/hat-1.jpg', 'jpg'),
      ('asset_hat_2', 'product_image_result', 'revision_image_result', 'https://source.test/hat-2.jpg', 'main', 'ready', 1200, 1200, '/tmp/hat-2.jpg', 'jpg'),
      ('asset_hat_3', 'product_image_result', 'revision_image_result', 'https://source.test/hat-3.jpg', 'detail', 'ready', 1200, 1200, '/tmp/hat-3.jpg', 'jpg'),
      ('asset_start_1', 'product_image_start', 'revision_image_start', 'https://source.test/start-1.jpg', 'main', 'ready', 1200, 1200, '/tmp/start-1.jpg', 'jpg'),
      ('asset_start_2', 'product_image_start', 'revision_image_start', 'https://source.test/start-2.jpg', 'main', 'ready', 1200, 1200, '/tmp/start-2.jpg', 'jpg'),
      ('asset_gen_1', 'product_image_result', 'revision_image_result', 'https://provider.test/gen-1.png', 'generated', 'ready', 1200, 1200, '/tmp/gen-1.png', 'png'),
      ('asset_gen_2', 'product_image_result', 'revision_image_result', 'https://provider.test/gen-2.png', 'generated', 'ready', 1200, 1200, '/tmp/gen-2.png', 'png'),
      ('asset_gen_3', 'product_image_result', 'revision_image_result', 'https://provider.test/gen-3.png', 'generated', 'ready', 1200, 1200, '/tmp/gen-3.png', 'png');
    INSERT INTO image_generation_templates (id, name, category_key, parent_category_key, active_version_id, enabled)
    VALUES ('template_hat', '草帽洗图模板', 'women.hat', 'women', NULL, true);
    INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe, activated_at)
    VALUES ('template_hat_v1', 'template_hat', 1, 'active',
      '{"inputCounts":{"default":2,"min":1,"max":6},"outputCounts":{"default":4,"min":1,"max":8},"mustPreserve":["帽檐结构"],"visualDirection":"海边度假","forbidden":["改变颜色"],"roles":[{"key":"hero","instruction":"商品主图"}]}'::jsonb, now());
    UPDATE image_generation_templates SET active_version_id = 'template_hat_v1' WHERE id = 'template_hat';
    INSERT INTO image_generation_batches
      (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count, category_key,
       template_id, template_version_id, template_version, recipe_snapshot, product_facts_snapshot, product_facts_digest, state)
    VALUES ('batch_image_result', 'product_image_result', 'revision_image_result', 'idem_image_result',
      '["asset_hat_1","asset_hat_2"]'::jsonb, 4, 'women.hat', 'template_hat', 'template_hat_v1', 1,
      '{"version":1,"inputCount":2,"outputCount":4,"mustPreserve":[],"visualDirection":"海边度假","forbidden":[],"roles":[{"key":"hero","instruction":"商品主图"}],"providerParameters":{}}'::jsonb,
      '{}'::jsonb, 'digest', 'partial_success');
    INSERT INTO image_generation_slots
      (id, batch_id, slot_number, role, business_key, state, attempt, archived_asset_id, error)
    VALUES
      ('slot_image_1', 'batch_image_result', 1, 'hero', 'slot:image:1', 'succeeded', 1, 'asset_gen_1', NULL),
      ('slot_image_2', 'batch_image_result', 2, 'detail', 'slot:image:2', 'succeeded', 1, 'asset_gen_2', NULL),
      ('slot_image_3', 'batch_image_result', 3, 'detail', 'slot:image:3', 'succeeded', 1, 'asset_gen_3', NULL),
      ('slot_image_4', 'batch_image_result', 4, 'detail', 'slot:image:4', 'failed', 1, NULL, '{"code":"provider_error"}'::jsonb);
  `);
});

test.afterAll(async () => database.close());

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/assets/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: pixel }));
  await page.route("https://source.test/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: pixel }));
});

test("详情页直接分区展示原图与洗图结果，并持久化最终顺序", async ({ page }) => {
  await page.goto("/products");
  await expect(page.getByRole("region", { name: /商品 product_image_result 原产品图/ })).toHaveCount(0);
  await page.goto("/products/product_image_result");

  const originals = page.getByRole("region", { name: "商品 product_image_result 原产品图" });
  const processed = page.getByRole("region", { name: "商品 product_image_result 洗图后的图" });
  await expect(originals.getByRole("button", { name: /放大原产品图/ })).toHaveCount(3);
  await expect(processed.getByRole("button", { name: /放大洗图后的图/ })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "重新生成这张" })).toBeVisible();

  await page.getByRole("checkbox", { name: "使用第 2 张" }).uncheck();
  await page.getByRole("button", { name: "第 3 张左移" }).click();
  const acceptResponse = page.waitForResponse((response) => response.url().endsWith("/batch_image_result/accept"));
  await page.getByRole("button", { name: "确认使用这 2 张图片" }).click();
  const accepted = await acceptResponse;
  const acceptanceEvidence = {
    status: accepted.status(),
    body: await accepted.text(),
    origin: accepted.request().headers().origin ?? null,
    contentType: accepted.request().headers()["content-type"] ?? null
  };
  expect(acceptanceEvidence).toMatchObject({ status: 200 });
  await page.reload();
  await expect(page.getByText("已确认最终图片顺序")).toBeVisible();
  await expect(page.getByText("主图 · 第 3 张")).toBeVisible();
  await expect(page.getByText("3853105827", { exact: true })).toBeVisible();
  await expect(page.getByText("2 张", { exact: true })).toBeVisible();

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  }
});

test("开始洗图使用明确输入输出和类目模板，并携带独立操作标识", async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/api/v1/products/product_image_start/image-generations", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ batchId: "batch_new", plannerJobId: "job_new" }) });
  });
  await page.goto("/products/product_image_start");
  await expect(page.getByRole("combobox", { name: "洗图品类" })).toHaveValue("women.hat");
  await page.getByRole("checkbox", { name: "选作洗图输入 原产品图 1" }).check();
  await page.getByRole("checkbox", { name: "选作洗图输入 原产品图 2" }).check();
  await page.getByRole("button", { name: "开始洗图" }).click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({
    revisionId: "revision_image_start",
    categoryKey: "women.hat",
    selectedAssetIds: ["asset_start_1", "asset_start_2"],
    outputCount: 4,
    runIntentId: expect.any(String)
  });
});
