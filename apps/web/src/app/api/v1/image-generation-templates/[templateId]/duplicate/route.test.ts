import { describe, expect, it, vi } from "vitest";

import { createPostHandler } from "./route";

function request(body: unknown) {
  return new Request("http://127.0.0.1/api/v1/image-generation-templates/tmpl_1/duplicate", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("duplicate image-generation-template route", () => {
  it("requires a distinct target category and passes the route template id", async () => {
    const duplicate = vi.fn().mockResolvedValue({ templateId: "tmpl_copy" });
    const handler = createPostHandler({ service: { duplicate } as never });

    const response = await handler(
      request({ targetCategoryKey: "women.hat.copy", version: 2 }),
      { params: Promise.resolve({ templateId: "tmpl_1" }) }
    );

    expect(response.status).toBe(201);
    expect(duplicate).toHaveBeenCalledWith("tmpl_1", 2, "women.hat.copy");
  });

  it("rejects the legacy ambiguous body", async () => {
    const handler = createPostHandler({ service: { duplicate: vi.fn() } as never });
    const response = await handler(
      request({ categoryKey: "women.hat", version: 2 }),
      { params: Promise.resolve({ templateId: "tmpl_1" }) }
    );

    expect(response.status).toBe(400);
  });

  it("returns a conflict when the target category already exists", async () => {
    const handler = createPostHandler({
      service: { duplicate: vi.fn().mockRejectedValue(new Error("category_key_exists")) } as never
    });
    const response = await handler(
      request({ targetCategoryKey: "women.hat.copy", version: 2 }),
      { params: Promise.resolve({ templateId: "tmpl_1" }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "category_key_exists" });
  });
});
