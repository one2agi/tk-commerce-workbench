import { expect, test } from "@playwright/test";
import type { WorkspaceSettingsView } from "../apps/web/src/server/services/settings-service.js";

type SettingsPatch = Record<string, unknown> & {
  secretMutations?: Record<string, unknown>;
};

test("settings sends only explicit secret replacement and reports the Worker-applied version", async ({ page, request }) => {
  const initialResponse = await request.get("/api/v1/settings");
  expect(initialResponse.ok()).toBeTruthy();
  const initial = await initialResponse.json() as WorkspaceSettingsView;
  let patchBody: SettingsPatch | undefined;

  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patchBody = route.request().postDataJSON() as SettingsPatch;
    const version = Number(initial.version) + 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...initial,
        ...patchBody,
        version,
        serviceSecretStatus: {
          ...(initial.serviceSecretStatus ?? {}),
          imagePlannerApiKey: true
        },
        runtimeStatus: {
          ...initial.runtimeStatus,
          savedVersion: version,
          appliedVersion: version,
          applyState: "applied",
          applyErrorCode: null
        }
      })
    });
  });

  await page.goto("/settings");
  await page.getByRole("radio", { name: /Headless API/ }).check();
  await page.getByLabel("Planner API 地址").fill("https://planner.test/v1");
  await page.getByLabel("Planner 模型").fill("planner-v2");
  await page.getByLabel("图片 API 地址").fill("https://images.test/v1");
  await page.getByLabel("图片模型").fill("image-v2");
  await page.getByLabel("Planner API Key").fill("planner-key-v2");
  await page.getByRole("button", { name: "保存更改" }).click();

  await expect(page.getByRole("status")).toContainText(`v${Number(initial.version) + 1}`);
  expect(patchBody?.secretMutations).toEqual({
    imagePlannerApiKey: { action: "replace", value: "planner-key-v2" }
  });
  expect(JSON.stringify(patchBody)).not.toContain("encryptedSecrets");
});
