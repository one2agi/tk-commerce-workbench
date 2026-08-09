import { describe, expect, it, vi } from "vitest";

import { SettingsValidationError } from "../../../../server/services/settings-service.js";
import { createPatchHandler } from "./route.js";

describe("runtime settings route", () => {
  it("maps a safe field validation error without exposing its cause", async () => {
    const update = vi.fn(async () => {
      throw new SettingsValidationError("image_provider_api_key_required", "imageProviderApiKey");
    });
    const handler = createPatchHandler({ service: { update } as never });
    const response = await handler(new Request("http://127.0.0.1/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({
        expectedVersion: 1,
        secretMutations: { imageProviderApiKey: { action: "clear" } }
      })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "image_provider_api_key_required",
      field: "imageProviderApiKey"
    });
  });

  it("rejects assetRoot as a deployment-owned field before calling the service", async () => {
    const update = vi.fn();
    const handler = createPatchHandler({ service: { update } as never });
    const response = await handler(new Request("http://127.0.0.1/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ expectedVersion: 1, assetRoot: "/from/browser" })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(update).not.toHaveBeenCalled();
  });
});
