import { ConfirmMiaoshouEditV1, type ConfirmMiaoshouEditV1 as ConfirmCommand } from "@tk/contracts";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";
import { conflictResponse } from "../../../../../../server/http/safe-conflict";

type Context = { params: Promise<{ productId: string }> };
export interface ApprovalPort {
  confirmAndEnqueue(command: ConfirmCommand): Promise<{ approvalSnapshotId: string; syncId: string }>;
}

export function createPostHandler(dependencies: { approvals: ApprovalPort }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;
    const { productId } = await context.params;
    const parsed = ConfirmMiaoshouEditV1.safeParse({ ...(await request.json().catch(() => null)), productId });
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      return Response.json(await dependencies.approvals.confirmAndEnqueue(parsed.data), { status: 202 });
    } catch (error) {
      const conflict = conflictResponse(error);
      if (conflict) return conflict;
      const code = (error as { code?: string }).code ?? "confirmation_failed";
      if (code === "approval_conflict") {
        return Response.json({ error: code }, { status: 409 });
      }
      if (code === "approval_sync_in_progress") {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: code }, { status: code === "approval_mapping_not_ready" ? 503 : 500 });
    }
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ approvals: (await getServerServices()).approvals })(request, context);
}
