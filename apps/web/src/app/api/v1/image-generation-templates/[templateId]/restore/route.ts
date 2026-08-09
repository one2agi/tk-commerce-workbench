import { z } from "zod";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import type { ImageGenerationTemplateService } from "../../../../../../server/services/image-generation-template-service";

const RestoreBody = z.strictObject({
  categoryKey: z.string().trim().min(1).max(120),
  version: z.number().int().positive()
});

export function createPostHandler(dependencies: { service: ImageGenerationTemplateService }) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = RestoreBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request", detail: parsed.error.format() }, { status: 400 });
    }
    try {
      const result = await dependencies.service.restoreVersion(parsed.data.categoryKey, parsed.data.version);
      return Response.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "template_not_found" || message === "version_not_found") {
        return Response.json({ error: message }, { status: 404 });
      }
      throw err;
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).imageGenerationTemplates })(request);
}
