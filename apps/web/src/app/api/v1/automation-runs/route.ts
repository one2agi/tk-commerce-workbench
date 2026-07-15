import { StartAutomationV1 } from "@tk/contracts/commands";

import type { AutomationService } from "../../../../server/services/automation-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../server/auth/loopback";

export function createPostHandler(dependencies: { service: AutomationService }) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;
    const unsafeMutation = rejectUnsafeBrowserMutation(request);
    if (unsafeMutation) return unsafeMutation;
    const parsed = StartAutomationV1.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      return Response.json(await dependencies.service.start(parsed.data), { status: 202 });
    } catch (error) {
      const message = error instanceof Error && error.message === "revision_not_found"
        ? "revision_not_found"
        : "automation_start_failed";
      return Response.json({ error: message }, { status: message === "revision_not_found" ? 404 : 500 });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../server/composition");
  return createPostHandler({ service: (await getServerServices()).automation })(request);
}
