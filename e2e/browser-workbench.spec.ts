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
      ('revision_browser_a', 'product_browser_a', 1, '轻薄防晒男士夹克', '{}', '{}'),
      ('revision_browser_b', 'product_browser_b', 1, '运动短裤', '{}', '{}');
    INSERT INTO listing_drafts
      (id, product_id, revision_id, draft_version, target_locale, style, title, description)
    VALUES
      ('listing_browser_a', 'product_browser_a', 'revision_browser_a', 1, 'th-TH', 'clean', 'เสื้อแจ็กเก็ตกันแดด', ''),
      ('listing_browser_b', 'product_browser_b', 'revision_browser_b', 1, 'th-TH', 'clean', 'กางเกงกีฬาขาสั้น', '');
    INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state)
    VALUES
      ('asset_browser_a', 'product_browser_a', 'revision_browser_a', 'https://assets.example/a.jpg', 'main', 'ready'),
      ('asset_browser_b', 'product_browser_b', 'revision_browser_b', 'https://assets.example/b.jpg', 'main', 'ready');
  `);
});

test.afterAll(async () => {
  await database.close();
});

test("真实桌面页面保留高密度工作台布局、筛选勾选与抽屉键盘上下文", async ({ page }) => {
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
  await page.getByRole("checkbox", { name: "选择商品 product_browser_a" }).check();
  const opener = page.getByRole("button", { name: "查看详情 product_browser_a" });
  await opener.click();

  const drawer = page.getByRole("dialog", { name: "商品详情" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "轻薄防晒男士夹克" })).toBeVisible();
  await expect(drawer.getByText("product_browser_a", { exact: true })).toBeVisible();
  await expect(drawer.getByText("เสื้อแจ็กเก็ตกันแดด", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "开始处理 product_browser_a" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "关闭详情" })).toBeFocused();
  const tableBox = await page.getByRole("region", { name: "待处理商品表（2/2）" }).boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect(tableBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.x).toBeGreaterThan(tableBox!.x);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "选择商品 product_browser_a" })).toBeChecked();
  await expect(page.getByRole("button", { name: "待处理" })).toHaveAttribute("aria-pressed", "true");

  await database.pool.query(
    "UPDATE product_revisions SET source_title = '轻薄防晒男士夹克（已刷新）' WHERE id = 'revision_browser_a'"
  );
  await page.reload();
  await page.getByRole("button", { name: "待处理" }).click();
  await page.getByRole("button", { name: "查看详情 product_browser_a" }).click();
  await expect(drawer.getByRole("heading", { name: "轻薄防晒男士夹克（已刷新）" })).toBeVisible();
  await expect(drawer.getByText("product_browser_a", { exact: true })).toBeVisible();
  await expect(drawer.getByText("เสื้อแจ็กเก็ตกันแดด", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "开始处理 product_browser_a" })).toBeEnabled();
  await expect(drawer.getByText("product_browser_b", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

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
