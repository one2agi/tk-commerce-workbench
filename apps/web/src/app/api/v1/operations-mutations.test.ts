import { describe, expect, it } from "vitest";

import { createPatchHandler as createSettingsPatch } from "./settings/route";
import {
  createPatchHandler as createTemplatePatch,
  createPostHandler as createTemplatePost
} from "./templates/route";

function mutation(url: string, body: unknown, origin = "http://127.0.0.1") {
  return new Request(url, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("settings mutation route", () => {
  it("rejects secret-shaped fields before calling the service", async () => {
    let updates = 0;
    const handler = createSettingsPatch({
      service: { update: async () => { updates += 1; return {}; } } as never
    });
    const response = await handler(mutation("http://127.0.0.1/api/v1/settings", {
      expectedVersion: 1,
      canvasApiKey: "TEST_SECRET_MUST_NOT_PERSIST"
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("TEST_SECRET_MUST_NOT_PERSIST");
    expect(updates).toBe(0);
  });

  it("requires same-origin JSON and returns safe conflict metadata", async () => {
    const service = {
      update: async () => { throw Object.assign(new Error("conflict"), { actualVersion: 3 }); }
    };
    const unsafe = await createSettingsPatch({ service: service as never })(new Request(
      "http://127.0.0.1/api/v1/settings",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }
    ));
    expect(unsafe.status).toBe(403);

    const conflict = await createSettingsPatch({ service: service as never })(mutation(
      "http://127.0.0.1/api/v1/settings", { expectedVersion: 1, defaultLocale: "vi-VN" }
    ));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "settings_version_conflict", actualVersion: 3 });
  });

  it("accepts zero as unlimited and the complete non-secret image settings contract", async () => {
    let command: unknown;
    const handler = createSettingsPatch({
      service: { update: async (value: unknown) => { command = value; return { version: 2 }; } } as never
    });
    const response = await handler(mutation("http://127.0.0.1/api/v1/settings", {
      expectedVersion: 1,
      maxCanvasRunsPerDay: 0,
      providerOptions: {
        listingProvider: "rules",
        listingModel: "rules-v1",
        canvasWorkflow: "TK工作流",
        imageGenerationPath: "headless",
        imagePlannerModel: "planner-v4",
        imageProviderModel: "image-v2"
      }
    }));

    expect(response.status).toBe(200);
    expect(command).toMatchObject({ maxCanvasRunsPerDay: 0, providerOptions: { imageGenerationPath: "headless" } });
  });
});

describe("template mutation routes", () => {
  it("creates and versions templates through protected JSON mutations", async () => {
    const calls: string[] = [];
    const service = {
      create: async () => { calls.push("create"); return { templateId: "template-1", version: 1 }; },
      update: async () => { calls.push("update"); return { templateId: "template-1", version: 2 }; }
    };
    const body = {
      name: "TK", categoryRules: [], referenceAssetIds: [], promptFragment: "clean",
      targetLocale: "th-TH", visualStyle: "marketplace", enabled: true
    };
    const created = await createTemplatePost({ service: service as never })(mutation(
      "http://127.0.0.1/api/v1/templates", body
    ));
    const updated = await createTemplatePatch({ service: service as never })(mutation(
      "http://127.0.0.1/api/v1/templates",
      { templateId: "template-1", expectedVersion: 1, promptFragment: "summer" }
    ));
    expect([created.status, updated.status]).toEqual([201, 200]);
    expect(calls).toEqual(["create", "update"]);
  });
});
