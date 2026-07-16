import { ConfirmMiaoshouEditV1, type ConfirmMiaoshouEditV1 as ConfirmCommand } from "@tk/contracts";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";

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
    return Response.json(await dependencies.approvals.confirmAndEnqueue(parsed.data), { status: 202 });
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { getServerServices } = await import("../../../../../../server/composition");
    return await createPostHandler({ approvals: (await getServerServices()).approvals })(request, context);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "confirmation_failed";
    const status = /stale|conflict/.test(code) ? 409 : code === "approval_mapping_not_ready" ? 503 : 500;
    return Response.json({ error: code }, { status });
  }
}
