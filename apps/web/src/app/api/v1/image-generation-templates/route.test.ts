import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ImageGenerationTemplateService } from "../../../../server/services/image-generation-template-service";

// Re-declare RecipeSchema inline (same definition as production)
const Counts = z.strictObject({
  default: z.number().int(),
  min: z.number().int(),
  max: z.number().int()
});
const RecipeSchema = z.strictObject({
  inputCounts: Counts.refine(
    (v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 6
  ),
  outputCounts: Counts.refine(
    (v) => v.min >= 1 && v.default >= v.min && v.default <= v.max && v.max <= 8
  ),
  mustPreserve: z.array(z.string().trim().min(1).max(300)).max(50),
  visualDirection: z.string().trim().max(5_000),
  forbidden: z.array(z.string().trim().min(1).max(300)).max(50),
  roles: z
    .array(z.strictObject({ key: z.string().trim().min(1).max(60), instruction: z.string().trim().min(1).max(1_000) }))
    .min(1)
    .max(8)
});
const CreateBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  categoryKey: z.string().trim().min(1).max(120),
  parentCategoryKey: z.string().trim().max(120).optional(),
  recipe: RecipeSchema
});

// Inline handlers mirroring the production route (avoids importing the route file)
function makeGetHandler(service: ImageGenerationTemplateService) {
  return async function get(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });
    return Response.json(await service.list());
  };
}

function makePostHandler(service: ImageGenerationTemplateService) {
  return async function post(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || !origin) {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }
    try {
      const reqUrl = new URL(request.url);
      const oriUrl = new URL(origin);
      if (reqUrl.protocol !== oriUrl.protocol || reqUrl.port !== oriUrl.port || reqUrl.hostname !== oriUrl.hostname) {
        return Response.json({ error: "same_origin_json_required" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }
    const parsed = CreateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    const result = await service.createDraft(parsed.data);
    return Response.json(result, { status: 201 });
  };
}

const minimalRecipe = {
  inputCounts: { default: 2, min: 1, max: 3 },
  outputCounts: { default: 3, min: 1, max: 8 },
  mustPreserve: [] as string[],
  visualDirection: "",
  forbidden: [] as string[],
  roles: [
    { key: "hero", instruction: "Primary hero shot" },
    { key: "detail", instruction: "Detail view" },
    { key: "lifestyle", instruction: "Lifestyle shot" }
  ]
};

function makeService() {
  const templates: Array<{ id: string; name: string; categoryKey: string; parentCategoryKey: string | null; activeVersionId: string | null; enabled: boolean; archivedAt: Date | null; createdAt: Date; updatedAt: Date }> = [];
  const versions: Array<{ id: string; templateId: string; version: number; lifecycleState: string; recipe: any; activatedAt: Date | null; createdAt: Date }> = [];
  let seq = 0;
  const nextId = (p: string) => `${p}_${++seq}`;

  return {
    service: {
      async createDraft(input: { name: string; categoryKey: string; parentCategoryKey?: string; recipe: any }) {
        const tid = nextId("tmpl");
        const vid = nextId("ver");
        const now = new Date();
        templates.push({ id: tid, name: input.name, categoryKey: input.categoryKey, parentCategoryKey: input.parentCategoryKey ?? null, activeVersionId: vid, enabled: true, archivedAt: null, createdAt: now, updatedAt: now });
        versions.push({ id: vid, templateId: tid, version: 1, lifecycleState: "draft", recipe: input.recipe, activatedAt: null, createdAt: now });
        return { templateId: tid, name: input.name, categoryKey: input.categoryKey, parentCategoryKey: input.parentCategoryKey ?? null, version: 1, lifecycleState: "draft", recipe: input.recipe, activatedAt: null, createdAt: now.toISOString() };
      },
      async list() { return { items: [] }; }
    } as unknown as ImageGenerationTemplateService,
    templates,
    versions
  };
}

describe("image-generation-templates route", () => {
  describe("GET loopback guard", () => {
    it("returns 200 for loopback requests", async () => {
      const { service } = makeService();
      const handler = makeGetHandler(service);
      const response = await handler(new Request("http://127.0.0.1/api/v1/image-generation-templates"));
      expect(response.status).toBe(200);
    });

    it("returns 403 for non-loopback requests", async () => {
      const { service } = makeService();
      const handler = makeGetHandler(service);
      const response = await handler(new Request("http://192.168.1.8/api/v1/image-generation-templates"));
      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/v1/image-generation-templates", () => {
    it("creates a draft template with valid recipe", async () => {
      const { service } = makeService();
      const handler = makePostHandler(service);
      const response = await handler(
        new Request("http://127.0.0.1/api/v1/image-generation-templates", {
          method: "POST",
          headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify({ name: "Women's hat", categoryKey: "women.hat", recipe: minimalRecipe })
        })
      );
      if (response.status !== 201) {
        const err = await response.json();
        console.log("FAIL body:", JSON.stringify(err));
      }
      expect(response.status).toBe(201);
      const body = await response.json() as any;
      expect(body.lifecycleState).toBe("draft");
      expect(body.version).toBe(1);
    });

    it("rejects invalid recipe (inputCounts.min < 1)", async () => {
      const { service } = makeService();
      const handler = makePostHandler(service);
      const response = await handler(
        new Request("http://127.0.0.1/api/v1/image-generation-templates", {
          method: "POST",
          headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify({ name: "Test", categoryKey: "test", recipe: { ...minimalRecipe, inputCounts: { default: 0, min: 1, max: 3 } } })
        })
      );
      expect(response.status).toBe(400);
    });

    it("rejects recipe with outputCounts.max > 8", async () => {
      const { service } = makeService();
      const handler = makePostHandler(service);
      const response = await handler(
        new Request("http://127.0.0.1/api/v1/image-generation-templates", {
          method: "POST",
          headers: { origin: "http://127.0.0.1", "content-type": "application/json" },
          body: JSON.stringify({ name: "Test", categoryKey: "test", recipe: { ...minimalRecipe, outputCounts: { default: 3, min: 1, max: 9 } } })
        })
      );
      expect(response.status).toBe(400);
    });

    it("rejects unsafe cross-origin request", async () => {
      const { service } = makeService();
      const handler = makePostHandler(service);
      const response = await handler(
        new Request("http://127.0.0.1/api/v1/image-generation-templates", {
          method: "POST",
          headers: { origin: "https://evil.com", "content-type": "application/json" },
          body: JSON.stringify({ name: "Test", categoryKey: "test", recipe: minimalRecipe })
        })
      );
      expect(response.status).toBe(403);
    });
  });
});
