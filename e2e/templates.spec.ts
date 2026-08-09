import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { openE2eDatabase } from "./fixtures/test-database.js";

let database: Awaited<ReturnType<typeof openE2eDatabase>>;

test.beforeAll(async () => {
  database = await openE2eDatabase(process.env.TEST_DATABASE_URL);
  await database.reset();
  await database.migrate(await readFile(resolve(process.cwd(), "packages/db/drizzle/0000_initial.sql"), "utf8"));
  await database.pool.query(`
    INSERT INTO image_generation_templates
      (id, name, category_key, parent_category_key, active_version_id, enabled)
    VALUES
      ('template_active', '女帽主图', 'women.hat', 'women', NULL, true),
      ('template_draft', '女包细节图', 'women.bag', 'women', NULL, true);
    INSERT INTO image_generation_template_versions
      (id, template_id, version, lifecycle_state, recipe, activated_at)
    VALUES
      ('template_active_v2', 'template_active', 2, 'active',
       '{"inputCounts":{"default":2,"min":1,"max":6},"outputCounts":{"default":4,"min":1,"max":8},"mustPreserve":["帽檐结构"],"visualDirection":"干净的商品主图","forbidden":["改变颜色"],"roles":[{"key":"hero","instruction":"商品主体主图"}]}'::jsonb, now()),
      ('template_draft_v1', 'template_draft', 1, 'draft',
       '{"inputCounts":{"default":2,"min":1,"max":6},"outputCounts":{"default":4,"min":1,"max":8},"mustPreserve":[],"visualDirection":"细节清晰","forbidden":[],"roles":[{"key":"detail","instruction":"商品细节特写"}]}'::jsonb, NULL);
    UPDATE image_generation_templates SET active_version_id = 'template_active_v2' WHERE id = 'template_active';
  `);
});

test.afterAll(async () => database.close());

test("生图模板页展示真实状态并提供安全的桌面配置体验", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/templates");

  await expect(page).toHaveTitle(/生图模板/);
  await expect(page.getByRole("heading", { name: "生图模板", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新建模板", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模板列表", level: 2 })).toBeVisible();
  await expect(page.getByText("女帽主图")).toBeVisible();
  await expect(page.getByText("已启用", { exact: true })).toBeVisible();
  await expect(page.getByText("草稿", { exact: true })).toBeVisible();

  const categoryInput = page.getByLabel("类目标识");
  await categoryInput.fill("Women Hat");
  await expect(categoryInput).toHaveJSProperty("validity.valid", false);

  await page.getByRole("article").filter({ hasText: "女帽主图" }).getByRole("button", { name: "高级设置" }).click();
  await expect(page.getByRole("group", { name: "模板内容" })).toBeVisible();
  await expect(page.getByRole("group", { name: "测试提示词" })).toContainText("会产生提示词模型费用");
  await expect(page.getByRole("button", { name: "测试提示词" })).toBeDisabled();

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
});
