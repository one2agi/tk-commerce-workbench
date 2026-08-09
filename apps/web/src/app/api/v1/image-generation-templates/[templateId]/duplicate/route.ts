import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import {
  CategoryKeySchema,
  type ImageGenerationTemplateService
} from "../../../../../../server/services/image-generation-template-service";

const DuplicateBody = z.strictObject({
  targetCategoryKey: CategoryKeySchema,
  version: z.number().int().positive()
});

export function createPostHandler(dependencies: { service: ImageGenerationTemplateService }) {
  return async function post(
    request: Request,
    { params }: { params: Promise<{ templateId: string }> }
  ): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = DuplicateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    try {
      const { templateId } = await params;
      const result = await dependencies.service.duplicate(
        templateId,
        parsed.data.version,
        parsed.data.targetCategoryKey
      );
      return Response.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "template_not_found" || message === "version_not_found") {
        return Response.json({ error: message }, { status: 404 });
      }
      if (message === "category_key_exists") {
        return Response.json({ error: message }, { status: 409 });
      }
      throw err;
    }
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ templateId: string }> }
): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).imageGenerationTemplates })(request, context);
}
