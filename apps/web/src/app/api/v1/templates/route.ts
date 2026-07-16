import { z } from "zod";

import type { TemplateService } from "../../../../server/services/template-service";
import { TemplateConflictError } from "../../../../server/services/template-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../server/auth/loopback";

const TemplateFields = {
  name: z.string().trim().min(1).max(120),
  categoryRules: z.array(z.strictObject({
    categoryKey: z.string().trim().min(1).max(120),
    priority: z.number().int().min(-10_000).max(10_000)
  })).max(100),
  referenceAssetIds: z.array(z.string().trim().min(1).max(200)).max(50),
  promptFragment: z.string().max(5_000),
  targetLocale: z.string().trim().min(2).max(35),
  visualStyle: z.string().trim().max(500),
  enabled: z.boolean()
};
const TemplateCreateBody = z.strictObject(TemplateFields);
const TemplateUpdateBody = z.strictObject({
  templateId: z.string().trim().min(1).max(200),
  expectedVersion: z.number().int().positive(),
  name: TemplateFields.name.optional(),
  categoryRules: TemplateFields.categoryRules.optional(),
  referenceAssetIds: TemplateFields.referenceAssetIds.optional(),
  promptFragment: TemplateFields.promptFragment.optional(),
  targetLocale: TemplateFields.targetLocale.optional(),
  visualStyle: TemplateFields.visualStyle.optional(),
  enabled: TemplateFields.enabled.optional()
});

export function createGetHandler(dependencies: { service: TemplateService }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.service.list());
  };
}

export function createPostHandler(dependencies: { service: TemplateService }) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = TemplateCreateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    return Response.json(await dependencies.service.create(parsed.data), { status: 201 });
  };
}

export function createPatchHandler(dependencies: { service: TemplateService }) {
  return async function patch(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;
    const parsed = TemplateUpdateBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      return Response.json(await dependencies.service.update(parsed.data));
    } catch (error) {
      if (error instanceof TemplateConflictError) {
        return Response.json({
          error: "template_version_conflict",
          actualVersion: error.actualVersion
        }, { status: 409 });
      }
      throw error;
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).templates })(request);
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).templates })(request);
}

export async function PATCH(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createPatchHandler({ service: (await getServerServices()).templates })(request);
}
