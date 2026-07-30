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
    INSERT INTO local_operators (id, handle, display_name)
    VALUES ('op_browser', 'local-operator', 'Local Operator');
    INSERT INTO products
      (id, operator_id, source_url, source_item_id, canonical_success_detail_id,
       locale, currency, state_source, state_automation)
    VALUES
      ('product_browser_a', 'op_browser', 'https://detail.1688.com/offer/892408514788.html',
       '892408514788', '3799770548', 'th-TH', 'THB', 'success', 'not_started'),
      ('product_browser_b', 'op_browser', 'https://detail.1688.com/offer/892408514999.html',
       '892408514999', '3799770549', 'th-TH', 'THB', 'success', 'not_started');
    INSERT INTO product_revisions
      (id, product_id, draft_version, source_title, source_payload, working_draft)
    VALUES
      ('revision_browser_a', 'product_browser_a', 1, '轻薄防晒男士夹克',
       '{"mainImages":[{"url":"https://cbu01.alicdn.com/img/ibank/source-a-1.jpg"},{"url":"https://cbu01.alicdn.com/img/ibank/source-a-2.jpg"}],"detailImages":[{"url":"https://cbu01.alicdn.com/img/ibank/source-a-2.jpg"},{"url":"https://cbu01.alicdn.com/img/ibank/source-a-3.jpg"}]}'::jsonb, '{}'),
      ('revision_browser_b', 'product_browser_b', 1, '运动短裤',
       '{"mainImages":[{"url":"https://cbu01.alicdn.com/img/ibank/source-b.jpg"}],"detailImages":[]}'::jsonb, '{}');
    INSERT INTO listing_drafts
      (id, product_id, revision_id, draft_version, target_locale, style, title, description)
    VALUES
      ('listing_browser_a', 'product_browser_a', 'revision_browser_a', 1, 'th-TH', 'clean', 'เสื้อแจ็กเก็ตกันแดด', ''),
      ('listing_browser_b', 'product_browser_b', 'revision_browser_b', 1, 'th-TH', 'clean', 'กางเกงกีฬาขาสั้น', '');
    INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state)
    VALUES
      ('asset_browser_a', 'product_browser_a', 'revision_browser_a', 'https://assets.example/a.jpg', 'main', 'ready'),
      ('asset_browser_b', 'product_browser_b', 'revision_browser_b', 'https://assets.example/b.jpg', 'main', 'ready');
    INSERT INTO canvas_runs
      (id, product_id, revision_id, template_id, template_version, state, outputs)
    VALUES
      ('canvas_browser_a', 'product_browser_a', 'revision_browser_a', 'template_browser', 1, 'success',
       '["https://canvas.example/product-a-1.jpg","https://canvas.example/product-a-2.jpg"]'::jsonb);
  `);
});

test.afterAll(async () => {
  await database.close();
});

test("approved navigation and product workbench surfaces are visible", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav).toContainText("商品");
  await expect(nav).toContainText("处理规则");
  await expect(nav).toContainText("写入记录");
  await expect(nav).toContainText("设置");
  await expect(nav).not.toContainText("任务中心");
  await expect(nav).not.toContainText("模板库");
  await expect(page.getByRole("button", { name: "待处理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "自动处理中" })).toBeVisible();
  await expect(page.getByRole("button", { name: "待确认" })).toBeVisible();
  await expect(page.getByRole("button", { name: "需要人工处理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "已完成" })).toBeVisible();
});

test("真实桌面页面保留高密度工作台布局、筛选勾选与批量开始处理", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "全部商品表（2/2）" })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await expect(page.locator("[draggable='true']")).toHaveCount(0);

  const sidebar = await page.getByRole("navigation", { name: "主导航" }).boundingBox();
  const main = await page.locator("main").boundingBox();
  expect(sidebar).not.toBeNull();
  expect(main).not.toBeNull();
  expect(sidebar!.width).toBeGreaterThanOrEqual(180);
  expect(main!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width);

  const stageButtons = page.getByRole("region", { name: "阶段看板" }).getByRole("button");
  await expect(stageButtons).toHaveCount(6);
  const stageBoxes = await stageButtons.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
  expect(new Set(stageBoxes.map((box) => Math.round(box.y))).size).toBe(1);

  await page.getByRole("button", { name: "待处理" }).click();
  await expect(page.getByRole("link", { name: "查看商品图片 product_browser_a" })).toHaveAttribute("href", "/products/product_browser_a");
  await expect(page.getByRole("link", { name: "查看详情 product_browser_a" })).toHaveAttribute("href", "/products/product_browser_a");
  const tableBox = await page.getByRole("region", { name: "待处理商品表（2/2）" }).boundingBox();
  expect(tableBox).not.toBeNull();
  await expect(page.getByRole("button", { name: "待处理" })).toHaveAttribute("aria-pressed", "true");

  await database.pool.query(
    "UPDATE product_revisions SET source_title = '轻薄防晒男士夹克（已刷新）' WHERE id = 'revision_browser_a'"
  );
  await page.reload();
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(page.getByRole("link", { name: "查看商品图片 product_browser_a" })).toContainText("เสื้อแจ็กเก็ตกันแดด");

  const startedRevisionIds: string[] = [];
  await page.route("**/api/v1/automation-runs", async (route) => {
    const body = route.request().postDataJSON() as { revisionIds: string[] };
    startedRevisionIds.push(...body.revisionIds);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        runs: body.revisionIds.map((revisionId) => ({ revisionId, runId: `run-${revisionId}`, created: true }))
      })
    });
  });
  await page.getByRole("checkbox", { name: "选择商品 product_browser_b" }).check();
  await page.getByRole("checkbox", { name: "选择商品 product_browser_a" }).check();
  await page.getByRole("button", { name: "批量开始处理（2）" }).click();
  await expect.poll(() => startedRevisionIds.length).toBe(2);
  expect(startedRevisionIds.sort()).toEqual(["revision_browser_a", "revision_browser_b"]);
});

test("商品列表直接按商品分开展示全部采集原图与洗图结果", async ({ page }) => {
  const imageBody = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await page.route("**/api/v1/source-images?**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody })
  );
  await page.route("https://canvas.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: imageBody })
  );

  await page.goto("/products/");

  const productGallery = page.getByRole("group", {
    name: "商品 product_browser_a 图片"
  });
  const originalRegion = productGallery.getByRole("region", {
    name: "商品 product_browser_a 原产品图"
  });
  const processedRegion = productGallery.getByRole("region", {
    name: "商品 product_browser_a 洗图后的图"
  });

  await expect(originalRegion.getByRole("button", { name: /放大原产品图/ })).toHaveCount(3);
  await expect(processedRegion.getByRole("button", { name: /放大洗图后的图/ })).toHaveCount(2);
  await expect(page.getByRole("group", {
    name: "商品 product_browser_b 图片"
  }).getByRole("button", { name: /放大原产品图/ })).toHaveCount(1);

  const sectionHeights = await productGallery
    .locator(".tk-product-image-gallery__section")
    .evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().height));
  expect(sectionHeights).toHaveLength(2);
  expect(Math.max(...sectionHeights)).toBeLessThanOrEqual(140);

  const firstOriginal = originalRegion.getByRole("button", { name: "放大原产品图 1/3" });
  await firstOriginal.click();
  const dialog = page.getByRole("dialog", { name: "原产品图预览" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(dialog).toContainText("2 / 3");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(firstOriginal).toBeFocused();

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
});
