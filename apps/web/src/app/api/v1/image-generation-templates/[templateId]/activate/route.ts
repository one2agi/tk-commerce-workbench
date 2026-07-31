import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import type { ImageGenerationTemplateService } from "../../../../../../server/services/image-generation-template-service";

const ActivateBody = z.strictObject({
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
    const { templateId } = await params;
    const parsed = ActivateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    try {
      const result = await dependencies.service.activate(templateId, parsed.data.version);
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "draft_version_not_found") {
        return Response.json({ error: "draft_version_not_found" }, { status: 404 });
      }
      throw err;
    }
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ templateId: string }> }
): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).imageGenerationTemplates })(request, { params });
}
