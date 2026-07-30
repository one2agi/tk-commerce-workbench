import { IngestLocalCapturesV3 } from "@tk/contracts/commands";

import type { ExtensionTokenVerifier } from "../../../../server/auth/extension-token";
import { rejectNonLoopback } from "../../../../server/auth/loopback";
import type { IngestService } from "../../../../server/services/ingest-service";

export function createPostHandler(dependencies: {
  verifyToken: ExtensionTokenVerifier;
  service: Pick<IngestService, "ingestLocal">;
}) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    if (!(await dependencies.verifyToken(request.headers.get("authorization")))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const payload = await request.json().catch(() => null);
    if (
      payload
      && typeof payload === "object"
      && ((payload as { version?: unknown }).version === 1
        || (payload as { version?: unknown }).version === 2)
    ) {
      return Response.json({
        error: "extension_upgrade_required",
        requiredVersion: 3
      }, { status: 409 });
    }
    const parsed = IngestLocalCapturesV3.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = await dependencies.service.ingestLocal(parsed.data);
    return Response.json(result, { status: 201 });
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
