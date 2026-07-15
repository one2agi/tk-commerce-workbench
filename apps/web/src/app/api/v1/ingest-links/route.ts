import { IngestLinksV1 } from "@tk/contracts/commands";

import type { ExtensionTokenVerifier } from "../../../../server/auth/extension-token";
import { rejectNonLoopback } from "../../../../server/auth/loopback";
import type { IngestService } from "../../../../server/services/ingest-service";

export function createPostHandler(dependencies: {
  verifyToken: ExtensionTokenVerifier;
  service: IngestService;
}) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    if (!(await dependencies.verifyToken(request.headers.get("authorization")))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const parsed = IngestLinksV1.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = await dependencies.service.ingest(parsed.data);
    return Response.json(result, { status: 202 });
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  const services = await getServerServices();
  return createPostHandler({
    verifyToken: services.verifyExtensionToken,
    service: services.ingest
  })(request);
}
