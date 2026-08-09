import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../server/auth/loopback";
import {
  CategoryKeySchema,
  RecipeSchema,
  type ImageGenerationTemplateService
} from "../../../../server/services/image-generation-template-service";

const CreateBody = z.strictObject({
  name: z.string().trim().min(1).max(120),
  categoryKey: CategoryKeySchema,
  parentCategoryKey: z.string().trim().max(120).optional(),
  recipe: RecipeSchema
});

export function createGetHandler(dependencies: { service: ImageGenerationTemplateService }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.service.list());
  };
}

export function createPostHandler(dependencies: { service: ImageGenerationTemplateService }) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = CreateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    try {
      const result = await dependencies.service.createDraft(parsed.data);
      return Response.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message === "category_key_exists") {
        return Response.json({ error: "category_key_exists" }, { status: 409 });
      }
      throw error;
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).imageGenerationTemplates })(request);
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).imageGenerationTemplates })(request);
}
