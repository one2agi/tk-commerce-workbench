import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../server/auth/loopback";
import {
  RecipeSchema,
  type ImageGenerationTemplateService
} from "../../../../../server/services/image-generation-template-service";

const UpdateBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  recipe: RecipeSchema
});

type Context = { params: Promise<{ templateId: string }> };

export function createPatchHandler(dependencies: { service: ImageGenerationTemplateService }) {
  return async function patch(request: Request, { params }: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = UpdateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    try {
      const { templateId } = await params;
      const result = await dependencies.service.updateDraft({
        templateId,
        expectedVersion: parsed.data.expectedVersion,
        recipeOverride: parsed.data.recipe
      });
      return Response.json(result, { status: 201 });
    } catch (error) {
      const code = error instanceof Error ? error.message : "template_update_failed";
      if (["template_not_found", "version_conflict"].includes(code)) {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "template_update_failed" }, { status: 500 });
    }
  };
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../server/composition");
  return createPatchHandler({ service: (await getServerServices()).imageGenerationTemplates })(request, context);
}
