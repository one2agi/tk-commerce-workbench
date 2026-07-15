import type { TemplateService } from "../../../../server/services/template-service";
import { rejectNonLoopback } from "../../../../server/auth/loopback";

export function createGetHandler(dependencies: { service: TemplateService }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    return Response.json(await dependencies.service.list());
  };
}

export async function GET(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createGetHandler({ service: (await getServerServices()).templates })(request);
}
